import { randomUUID } from "crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";

import { type DbClient, getDb, type TxClient } from "@/db";
import {
  files,
  memberships,
  type MembershipTier,
  membershipTiers,
  type PaymentMethod,
  paymentMethods,
  type PaymentRequest,
  paymentRequests,
  users,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/modules/audit";
import { grantMembership, revokeMembership } from "@/modules/membership";
import { enqueuePaymentProofCleanup } from "@/modules/payment/proof-lifecycle";
import { recordEvent } from "@/modules/system/events";
import { enqueueTask } from "@/modules/tasks";

import {
  type ExpiredPaymentEvent,
  getPaymentProvider,
  type PaidPaymentEvent,
  type ReversalPaymentEvent,
} from "./providers";

// ---------- 收款方式 ----------

export async function listPaymentMethods(opts?: {
  activeOnly?: boolean;
}): Promise<PaymentMethod[]> {
  const db = getDb();
  const base = db.select().from(paymentMethods);
  const rows = opts?.activeOnly ? await base.where(eq(paymentMethods.isActive, true)) : await base;
  return rows.sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function createPaymentMethod(input: {
  name: string;
  description?: string | null;
  qrFileId?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<PaymentMethod> {
  const [method] = await getDb().insert(paymentMethods).values(input).returning();
  return method;
}

export async function updatePaymentMethod(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    qrFileId: string | null;
    isActive: boolean;
    sortOrder: number;
  }>,
): Promise<PaymentMethod> {
  const [method] = await getDb()
    .update(paymentMethods)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(paymentMethods.id, id))
    .returning();
  if (!method) throw new ApiError(404, "paymentMethodNotFound");
  return method;
}

export async function deletePaymentMethod(id: string): Promise<void> {
  await getDb().delete(paymentMethods).where(eq(paymentMethods.id, id));
}

// ---------- 付款申请 ----------

/**
 * 所有进入 pending_review / pending_payment 的路径共享此事务锁。
 * createAutoCheckout 的固定锁序为 checkout-dedupe -> payment-pending。
 */
export async function acquirePendingPaymentLock(tx: TxClient, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`payment-pending:${userId}`}, 0))`,
  );
}

export type PaymentRequestDetail = {
  request: PaymentRequest;
  tier: MembershipTier;
  userEmail: string;
};

/** 校验付款截图文件：必须存在、用途为 payment_proof、且由本人上传 */
async function assertOwnProofFile(proofFileId: string, userId: string): Promise<void> {
  const [file] = await getDb().select().from(files).where(eq(files.id, proofFileId)).limit(1);
  if (!file || file.purpose !== "payment_proof" || file.createdBy !== userId) {
    throw new ApiError(400, "invalidPaymentProof");
  }
}

async function assertActivePaymentMethod(paymentMethodId: string): Promise<void> {
  const [method] = await getDb()
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.id, paymentMethodId), eq(paymentMethods.isActive, true)))
    .limit(1);
  if (!method) throw new ApiError(400, "paymentMethodUnavailable");
}

export async function createPaymentRequest(input: {
  userId: string;
  tierId: string;
  paymentMethodId?: string | null;
  proofFileId?: string | null;
  note?: string | null;
}): Promise<PaymentRequest> {
  const db = getDb();
  const [tier] = await db
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.id, input.tierId))
    .limit(1);
  if (!tier || !tier.isActive) throw new ApiError(404, "tierNotFound");
  if (!tier.purchaseEnabled) throw new ApiError(400, "tierUnavailable");
  if (input.paymentMethodId) await assertActivePaymentMethod(input.paymentMethodId);
  if (input.proofFileId) await assertOwnProofFile(input.proofFileId, input.userId);

  const request = await db.transaction(async (tx) => {
    await acquirePendingPaymentLock(tx, input.userId);
    // pending uniqueness is serialized by PostgreSQL transactions.
    const [existing] = await tx
      .select()
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.userId, input.userId),
          eq(paymentRequests.tierId, input.tierId),
          or(
            eq(paymentRequests.status, "pending_review"),
            eq(paymentRequests.status, "pending_payment"),
          ),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ApiError(400, "pendingPaymentExists");
    }

    const [created] = await tx
      .insert(paymentRequests)
      .values({
        userId: input.userId,
        tierId: input.tierId,
        paymentMethodId: input.paymentMethodId ?? null,
        status: "pending_review",
        flow: "manual",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
        proofFileId: input.proofFileId ?? null,
        note: input.note ?? null,
      })
      .onConflictDoNothing({
        target: [paymentRequests.userId, paymentRequests.tierId],
        where: sql.raw("status in ('pending_review', 'pending_payment')"),
      })
      .returning();
    if (!created) throw new ApiError(400, "pendingPaymentExists");
    return created;
  });

  await recordEvent("payment_request_created", {
    requestId: request.id,
    userId: input.userId,
    tierId: input.tierId,
  });
  return request;
}

export async function listMyPaymentRequests(
  userId: string,
): Promise<{ request: PaymentRequest; tier: MembershipTier }[]> {
  return getDb()
    .select({ request: paymentRequests, tier: membershipTiers })
    .from(paymentRequests)
    .innerJoin(membershipTiers, eq(paymentRequests.tierId, membershipTiers.id))
    .where(eq(paymentRequests.userId, userId))
    .orderBy(desc(paymentRequests.createdAt));
}

export async function listMyPaymentRequestDetails(
  userId: string,
): Promise<
  { request: PaymentRequest; tier: MembershipTier; paymentMethod: PaymentMethod | null }[]
> {
  return getDb()
    .select({
      request: paymentRequests,
      tier: membershipTiers,
      paymentMethod: paymentMethods,
    })
    .from(paymentRequests)
    .innerJoin(membershipTiers, eq(paymentRequests.tierId, membershipTiers.id))
    .leftJoin(paymentMethods, eq(paymentRequests.paymentMethodId, paymentMethods.id))
    .where(eq(paymentRequests.userId, userId))
    .orderBy(desc(paymentRequests.createdAt));
}

export async function listPaymentRequests(
  status?: PaymentRequest["status"],
): Promise<PaymentRequestDetail[]> {
  const db = getDb();
  const base = db
    .select({ request: paymentRequests, tier: membershipTiers, userEmail: users.email })
    .from(paymentRequests)
    .innerJoin(membershipTiers, eq(paymentRequests.tierId, membershipTiers.id))
    .innerJoin(users, eq(paymentRequests.userId, users.id));
  const rows = status
    ? await base.where(eq(paymentRequests.status, status)).orderBy(asc(paymentRequests.createdAt))
    : await base.orderBy(desc(paymentRequests.createdAt));
  return rows;
}

export async function getPaymentRequest(id: string): Promise<PaymentRequest | null> {
  const [request] = await getDb()
    .select()
    .from(paymentRequests)
    .where(eq(paymentRequests.id, id))
    .limit(1);
  return request ?? null;
}

export async function resubmitPaymentProof(input: {
  requestId: string;
  userId: string;
  proofFileId: string;
}): Promise<PaymentRequest> {
  await assertOwnProofFile(input.proofFileId, input.userId);
  const correlationId = randomUUID();
  return getDb().transaction(async (tx) => {
    await acquirePendingPaymentLock(tx, input.userId);
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(and(eq(paymentRequests.id, input.requestId), eq(paymentRequests.userId, input.userId)))
      .limit(1);
    if (!request) throw new ApiError(404, "paymentRequestNotFound");

    const [updated] = await tx
      .update(paymentRequests)
      .set({
        status: "pending_review",
        proofFileId: input.proofFileId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentRequests.id, input.requestId),
          eq(paymentRequests.userId, input.userId),
          eq(paymentRequests.status, "rejected"),
          sql`not exists (
            select 1
              from payment_requests other_pending
             where other_pending.user_id = ${input.userId}
               and other_pending.tier_id = ${request.tierId}
               and other_pending.status in ('pending_review', 'pending_payment')
               and other_pending.id <> ${input.requestId}
          )`,
        ),
      )
      .returning();
    if (!updated) {
      const [current] = await tx
        .select({ status: paymentRequests.status })
        .from(paymentRequests)
        .where(
          and(eq(paymentRequests.id, input.requestId), eq(paymentRequests.userId, input.userId)),
        )
        .limit(1);
      if (!current) throw new ApiError(404, "paymentRequestNotFound");
      if (current.status !== "rejected") throw new ApiError(400, "resubmitRejectedOnly");
      throw new ApiError(400, "pendingPaymentExists");
    }
    await recordAudit(tx, {
      entityType: "payment_request",
      entityId: updated.id,
      action: "resubmit",
      actor: { type: "user", id: input.userId },
      before: { status: "rejected", proofFileId: request.proofFileId },
      after: { status: "pending_review", proofFileId: updated.proofFileId },
      correlationId,
    });
    return updated;
  });
}

export async function cancelPaymentRequest(requestId: string, userId: string): Promise<void> {
  const request = await getPaymentRequest(requestId);
  if (!request || request.userId !== userId) throw new ApiError(404, "paymentRequestNotFound");
  const correlationId = randomUUID();
  await getDb().transaction(async (tx) => {
    const reviewedAt = new Date();
    const [updated] = await tx
      .update(paymentRequests)
      .set({ status: "cancelled", reviewedAt, updatedAt: reviewedAt })
      .where(
        and(
          eq(paymentRequests.id, requestId),
          eq(paymentRequests.userId, userId),
          eq(paymentRequests.status, "pending_review"),
        ),
      )
      .returning();
    if (!updated) throw new ApiError(400, "cancelPendingOnly");
    await enqueuePaymentProofCleanup(tx, updated);
    await recordAudit(tx, {
      entityType: "payment_request",
      entityId: updated.id,
      action: "cancel",
      actor: { type: "user", id: userId },
      before: { status: "pending_review" },
      after: { status: "cancelled" },
      correlationId,
    });
  });
}

export async function approvePaymentRequest(
  requestId: string,
  reviewerId: string,
): Promise<PaymentRequest> {
  const db = getDb();
  const correlationId = randomUUID();

  // 固定锁序：payment_requests 行锁 -> membership grant advisory lock。
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, requestId))
      .limit(1)
      .for("update");
    if (!locked) throw new ApiError(404, "paymentRequestNotFound");
    if (locked.status !== "pending_review") throw new ApiError(400, "paymentNotPending");

    const [row] = await tx
      .update(paymentRequests)
      .set({
        status: "approved",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.status, "pending_review")))
      .returning();
    if (!row) throw new ApiError(400, "paymentNotPending");

    await enqueuePaymentProofCleanup(tx, row);
    const approveEvent = await recordAudit(tx, {
      entityType: "payment_request",
      entityId: row.id,
      action: "approve",
      actor: { type: "admin", id: reviewerId },
      before: { status: "pending_review" },
      after: { status: "approved" },
      correlationId,
    });
    return finalizeApprovedPayment(tx, row, {
      source: "payment_review",
      actor: { type: "admin", id: reviewerId },
      createdBy: reviewerId,
      correlationId,
      causationId: approveEvent.id,
    });
  });
}

type ApprovalContext = {
  source: "payment_review" | "payment_auto";
  actor: { type: "admin"; id: string } | { type: "system"; id: null };
  createdBy: string | null;
  correlationId: string;
  causationId: string;
};

async function finalizeApprovedPayment(
  tx: TxClient,
  row: PaymentRequest,
  context: ApprovalContext,
): Promise<PaymentRequest> {
  const granted = await grantMembership(
    {
      userId: row.userId,
      tierId: row.tierId,
      source: context.source,
      durationDays: row.durationDays,
      note: `付款申请 ${row.id} 已确认`,
      createdBy: context.createdBy,
      actor: context.actor,
      correlationId: context.correlationId,
      causationId: context.causationId,
    },
    tx,
  );
  const [updated] = await tx
    .update(paymentRequests)
    .set({ grantedMembershipId: granted.membership.id })
    .where(eq(paymentRequests.id, row.id))
    .returning();
  if (!updated) throw new Error("Failed to link granted membership");

  const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) throw new Error("Payment request user not found");
  await enqueueTask(tx, {
    kind: "email",
    dedupeKey: `email:membership_activated:${row.id}`,
    payload: {
      template: "membership_activated",
      to: user.email,
      locale: user.locale,
      params: {
        tierName: granted.tier.name,
        endsAt: granted.membership.endsAt.toISOString(),
      },
    },
  });
  return updated;
}

const AUTO_CHECKOUT_CLAIM_LEASE_MS = 2 * 60 * 1000;

export async function createAutoCheckout(input: {
  userId: string;
  tierId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ redirectUrl: string }> {
  const db = getDb();
  const [tier] = await db
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.id, input.tierId))
    .limit(1);
  if (
    !tier ||
    !tier.isActive ||
    !tier.purchaseEnabled ||
    tier.priceAmountMinor === null ||
    !tier.currency
  ) {
    throw new ApiError(400, "tierNotPayable");
  }
  const amountMinor = tier.priceAmountMinor;
  const currency = tier.currency.toLowerCase();

  const provider = await getPaymentProvider("stripe", { requireEnabled: true });
  const claimToken = `creating:${randomUUID()}`;
  const checkoutClaim = await db.transaction(async (tx) => {
    // Fixed order: checkout dedupe lock -> shared pending-entry lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`stripe:${input.userId}:${input.tierId}`}))`,
    );
    await acquirePendingPaymentLock(tx, input.userId);
    const [existing] = await tx
      .select()
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.userId, input.userId),
          eq(paymentRequests.tierId, input.tierId),
          or(
            eq(paymentRequests.status, "pending_review"),
            eq(paymentRequests.status, "pending_payment"),
          ),
        ),
      )
      .limit(1);
    if (
      existing &&
      (existing.flow !== "auto" ||
        existing.provider !== "stripe" ||
        existing.status !== "pending_payment")
    ) {
      throw new ApiError(400, "pendingPaymentExists");
    }
    if (existing?.providerRef) {
      if (existing.providerRef.startsWith("creating:")) {
        const [reclaimed] = await tx
          .update(paymentRequests)
          .set({ providerRef: claimToken, updatedAt: sql`now()` })
          .where(
            and(
              eq(paymentRequests.id, existing.id),
              eq(paymentRequests.status, "pending_payment"),
              eq(paymentRequests.providerRef, existing.providerRef),
              sql`${paymentRequests.updatedAt} < now() - (${AUTO_CHECKOUT_CLAIM_LEASE_MS} * interval '1 millisecond')`,
            ),
          )
          .returning();
        if (!reclaimed) throw new ApiError(409, "paymentCheckoutChanged");
        return { request: reclaimed, claimToken };
      }
      return { request: existing, claimToken: null };
    }
    if (existing) {
      const [claimed] = await tx
        .update(paymentRequests)
        .set({ providerRef: claimToken, updatedAt: sql`now()` })
        .where(
          and(eq(paymentRequests.id, existing.id), eq(paymentRequests.status, "pending_payment")),
        )
        .returning();
      if (!claimed) throw new ApiError(409, "paymentCheckoutChanged");
      return { request: claimed, claimToken };
    }
    const [created] = await tx
      .insert(paymentRequests)
      .values({
        userId: input.userId,
        tierId: input.tierId,
        status: "pending_payment",
        flow: "auto",
        provider: "stripe",
        providerRef: claimToken,
        amountMinor,
        currency,
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .onConflictDoNothing({
        target: [paymentRequests.userId, paymentRequests.tierId],
        where: sql.raw("status in ('pending_review', 'pending_payment')"),
      })
      .returning();
    if (!created) throw new ApiError(400, "pendingPaymentExists");
    return { request: created, claimToken };
  });
  const { request } = checkoutClaim;
  if (!checkoutClaim.claimToken) {
    const checkout = await provider!.getCheckoutState(request.providerRef!);
    if (checkout.status === "open" && checkout.redirectUrl) {
      return { redirectUrl: checkout.redirectUrl };
    }
    if (checkout.status === "complete") {
      throw new ApiError(400, "pendingAutoPaymentExists");
    }
    await db
      .update(paymentRequests)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(paymentRequests.id, request.id),
          eq(paymentRequests.status, "pending_payment"),
          eq(paymentRequests.providerRef, request.providerRef!),
        ),
      );
    return createAutoCheckout(input);
  }

  try {
    const checkout = await provider!.createCheckout({
      requestId: request.id,
      amountMinor: request.amountMinor!,
      currency: request.currency!,
      tierName: tier.name,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
    const [updated] = await db
      .update(paymentRequests)
      .set({ providerRef: checkout.providerRef, updatedAt: new Date() })
      .where(
        and(
          eq(paymentRequests.id, request.id),
          eq(paymentRequests.status, "pending_payment"),
          eq(paymentRequests.providerRef, checkoutClaim.claimToken),
        ),
      )
      .returning({ id: paymentRequests.id });
    if (!updated) throw new ApiError(409, "paymentCheckoutChanged");
    return { redirectUrl: checkout.redirectUrl };
  } catch (error) {
    await db
      .update(paymentRequests)
      .set({ providerRef: null, updatedAt: new Date() })
      .where(
        and(
          eq(paymentRequests.id, request.id),
          eq(paymentRequests.status, "pending_payment"),
          eq(paymentRequests.providerRef, checkoutClaim.claimToken),
        ),
      );
    throw error;
  }
}

export async function confirmAutoPayment(
  providerId: string,
  event: PaidPaymentEvent,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [processed] = await tx
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.provider, providerId),
          eq(paymentRequests.providerEventId, event.providerEventId),
        ),
      )
      .limit(1);
    if (processed) return;

    const lookup = event.requestId
      ? or(
          eq(paymentRequests.providerRef, event.providerRef),
          eq(paymentRequests.id, event.requestId),
        )
      : eq(paymentRequests.providerRef, event.providerRef);
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(and(eq(paymentRequests.provider, providerId), lookup))
      .limit(1)
      .for("update");
    if (!request) return;

    if (event.requestId && request.id !== event.requestId) {
      throw new ApiError(409, "paymentReferenceMismatch");
    }
    if (
      request.providerRef &&
      !request.providerRef.startsWith("creating:") &&
      request.providerRef !== event.providerRef
    ) {
      throw new ApiError(409, "paymentReferenceMismatch");
    }
    if (
      request.amountMinor !== event.amountMinor ||
      request.currency?.toLowerCase() !== event.currency.toLowerCase()
    ) {
      throw new ApiError(409, "paymentAmountMismatch");
    }
    if (request.providerPaymentRef && request.providerPaymentRef !== event.paymentRef) {
      throw new ApiError(409, "paymentReferenceMismatch");
    }

    if (request.status === "reversed") {
      if (request.providerEventId) return;
      await tx
        .update(paymentRequests)
        .set({
          providerRef: event.providerRef,
          providerEventId: event.providerEventId,
          providerPaymentRef: event.paymentRef,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentRequests.id, request.id),
            eq(paymentRequests.status, "reversed"),
            sql`${paymentRequests.providerEventId} is null`,
          ),
        );
      return;
    }
    if (request.status !== "pending_payment") return;

    const correlationId = randomUUID();
    const reviewedAt = new Date();
    const [approved] = await tx
      .update(paymentRequests)
      .set({
        status: "approved",
        providerRef: event.providerRef,
        providerEventId: event.providerEventId,
        providerPaymentRef: event.paymentRef,
        reviewedAt,
        updatedAt: reviewedAt,
      })
      .where(and(eq(paymentRequests.id, request.id), eq(paymentRequests.status, "pending_payment")))
      .returning();
    if (!approved) return;
    await enqueuePaymentProofCleanup(tx, approved);
    const paymentEvent = await recordAudit(tx, {
      entityType: "payment_request",
      entityId: approved.id,
      action: "payment_auto_paid",
      actor: { type: "system", id: null },
      before: { status: "pending_payment" },
      after: {
        status: "approved",
        provider: providerId,
        providerEventId: event.providerEventId,
        paymentRef: event.paymentRef,
      },
      correlationId,
    });
    await finalizeApprovedPayment(tx, approved, {
      source: "payment_auto",
      actor: { type: "system", id: null },
      createdBy: null,
      correlationId,
      causationId: paymentEvent.id,
    });
  });
}

export async function expireAutoPayment(
  providerId: string,
  event: ExpiredPaymentEvent,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [processed] = await tx
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(eq(paymentRequests.providerEventId, event.providerEventId))
      .limit(1);
    if (processed) return;

    const lookup = event.requestId
      ? or(
          eq(paymentRequests.providerRef, event.providerRef),
          eq(paymentRequests.id, event.requestId),
        )
      : eq(paymentRequests.providerRef, event.providerRef);
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(and(eq(paymentRequests.provider, providerId), lookup))
      .limit(1)
      .for("update");
    if (!request || request.status !== "pending_payment") return;

    const correlationId = randomUUID();
    const expiredAt = new Date();
    const [cancelled] = await tx
      .update(paymentRequests)
      .set({
        status: "cancelled",
        providerRef: event.providerRef,
        providerEventId: event.providerEventId,
        reviewedAt: expiredAt,
        updatedAt: expiredAt,
      })
      .where(and(eq(paymentRequests.id, request.id), eq(paymentRequests.status, "pending_payment")))
      .returning();
    if (!cancelled) return;

    await enqueuePaymentProofCleanup(tx, cancelled);
    await recordAudit(tx, {
      entityType: "payment_request",
      entityId: cancelled.id,
      action: "payment_auto_expired",
      actor: { type: "system", id: null },
      before: { status: "pending_payment" },
      after: {
        status: "cancelled",
        provider: providerId,
        providerEventId: event.providerEventId,
      },
      correlationId,
    });
  });
}

export async function rejectPaymentRequest(
  requestId: string,
  reviewerId: string,
  reviewNote?: string | null,
): Promise<PaymentRequest> {
  const db = getDb();
  const request = await getPaymentRequest(requestId);
  if (!request) throw new ApiError(404, "paymentRequestNotFound");
  const correlationId = randomUUID();
  return db.transaction(async (tx) => {
    const reviewedAt = new Date();
    const [row] = await tx
      .update(paymentRequests)
      .set({
        status: "rejected",
        reviewNote: reviewNote ?? null,
        reviewedBy: reviewerId,
        reviewedAt,
        updatedAt: reviewedAt,
      })
      .where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.status, "pending_review")))
      .returning();
    if (!row) throw new ApiError(400, "paymentNotPending");
    await enqueuePaymentProofCleanup(tx, row);
    await recordAudit(tx, {
      entityType: "payment_request",
      entityId: row.id,
      action: "reject",
      actor: { type: "admin", id: reviewerId },
      reason: reviewNote?.trim() || null,
      before: { status: "pending_review" },
      after: { status: "rejected" },
      correlationId,
    });
    const [recipient] = await tx
      .select({ email: users.email, locale: users.locale, tierName: membershipTiers.name })
      .from(users)
      .innerJoin(membershipTiers, eq(membershipTiers.id, row.tierId))
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!recipient) throw new Error("Payment request recipient not found");
    await enqueueTask(tx, {
      kind: "email",
      dedupeKey: `email:payment_rejected:${requestId}:${reviewedAt.toISOString()}`,
      payload: {
        template: "payment_rejected",
        to: recipient.email,
        locale: recipient.locale,
        params: {
          tierName: recipient.tierName,
          reviewNote: reviewNote ?? null,
        },
      },
    });
    return row;
  });
}

type ApprovedPaymentReversalContext = {
  actor: { type: "admin"; id: string } | { type: "system"; id: null };
  reason: string;
  auditAction: "reverse" | "payment_auto_refunded" | "payment_auto_disputed";
  correlationId: string;
  auditAfterExtra?: Record<string, unknown>;
  notifyMember: boolean;
};

async function applyApprovedPaymentReversal(
  tx: DbClient,
  reversed: PaymentRequest,
  context: ApprovedPaymentReversalContext,
): Promise<void> {
  if (!reversed.grantedMembershipId) {
    throw new ApiError(409, "paymentGrantLinkMissing");
  }

  await enqueuePaymentProofCleanup(tx, reversed);
  const reverseEvent = await recordAudit(tx, {
    entityType: "payment_request",
    entityId: reversed.id,
    action: context.auditAction,
    actor: context.actor,
    reason: context.reason,
    before: { status: "approved" },
    after: { status: "reversed", ...(context.auditAfterExtra ?? {}) },
    correlationId: context.correlationId,
  });

  const [membership] = await tx
    .select()
    .from(memberships)
    .where(eq(memberships.id, reversed.grantedMembershipId))
    .limit(1)
    .for("update");
  if (!membership) throw new ApiError(404, "membershipNotFound");
  if (membership.status === "revoked") return;

  await revokeMembership(
    membership.id,
    {
      reason: context.reason,
      actor: context.actor,
      expectedVersion: membership.version,
      correlationId: context.correlationId,
      causationId: reverseEvent.id,
    },
    tx,
  );

  if (!context.notifyMember) return;
  const [recipient] = await tx
    .select({ email: users.email, locale: users.locale, tierName: membershipTiers.name })
    .from(users)
    .innerJoin(membershipTiers, eq(membershipTiers.id, reversed.tierId))
    .where(eq(users.id, reversed.userId))
    .limit(1);
  if (!recipient) throw new Error("Payment reversal recipient not found");
  await enqueueTask(tx, {
    kind: "email",
    dedupeKey: `email:membership_revoked:${reversed.id}`,
    payload: {
      template: "membership_revoked",
      to: recipient.email,
      locale: recipient.locale,
      params: { tierName: recipient.tierName },
    },
  });
}

export async function reverseAutoPayment(
  providerId: string,
  event: ReversalPaymentEvent,
): Promise<void> {
  const db = getDb();
  const [mappedPayment] = await db
    .select({ id: paymentRequests.id })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.provider, providerId),
        eq(paymentRequests.providerPaymentRef, event.paymentRef),
      ),
    )
    .limit(1);

  let checkout: Awaited<
    ReturnType<
      NonNullable<Awaited<ReturnType<typeof getPaymentProvider>>>["resolveCheckoutByPaymentIntent"]
    >
  > = null;
  if (!mappedPayment) {
    const provider = await getPaymentProvider(providerId);
    if (!provider) throw new ApiError(400, "paymentProviderUnsupported");
    checkout = await provider.resolveCheckoutByPaymentIntent(event.paymentRef);
  }

  await db.transaction(async (tx) => {
    const [processed] = await tx
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.provider, providerId),
          eq(paymentRequests.reversalEventId, event.providerEventId),
        ),
      )
      .limit(1);
    if (processed) return;

    let [request] = await tx
      .select()
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.provider, providerId),
          eq(paymentRequests.providerPaymentRef, event.paymentRef),
        ),
      )
      .limit(1)
      .for("update");

    if (!request && checkout) {
      [request] = await tx
        .select()
        .from(paymentRequests)
        .where(
          and(
            eq(paymentRequests.provider, providerId),
            eq(paymentRequests.providerRef, checkout.providerRef),
          ),
        )
        .limit(1)
        .for("update");
    }

    if (!request) {
      if (mappedPayment || checkout?.owned) {
        logger.error("Payment reversal target unavailable", {
          providerId,
          category: "owned_target_missing",
        });
        throw new ApiError(503, "paymentReversalTargetUnavailable");
      }
      logger.warn("Payment reversal ignored", {
        providerId,
        category: checkout ? "external_checkout" : "checkout_not_found",
      });
      return;
    }

    if (checkout?.owned && checkout.requestId && checkout.requestId !== request.id) {
      throw new ApiError(409, "paymentReferenceMismatch");
    }
    if (
      checkout &&
      request.providerRef &&
      !request.providerRef.startsWith("creating:") &&
      request.providerRef !== checkout.providerRef
    ) {
      throw new ApiError(409, "paymentReferenceMismatch");
    }
    if (request.providerPaymentRef && request.providerPaymentRef !== event.paymentRef) {
      throw new ApiError(409, "paymentReferenceMismatch");
    }
    if (request.status === "reversed") return;
    if (request.status === "rejected" || request.status === "cancelled") {
      logger.warn("Payment reversal ignored for terminal request", {
        providerId,
        requestId: request.id,
        category: request.status,
      });
      return;
    }
    if (request.status !== "pending_payment" && request.status !== "approved") {
      logger.warn("Payment reversal ignored for incompatible request", {
        providerId,
        requestId: request.id,
        category: request.status,
      });
      return;
    }

    const correlationId = randomUUID();
    const reviewedAt = new Date();
    const auditAction =
      event.type === "refunded" ? "payment_auto_refunded" : "payment_auto_disputed";
    const reason =
      event.type === "refunded" ? "Stripe full refund confirmed" : "Stripe dispute created";
    const previousStatus = request.status;
    const [reversed] = await tx
      .update(paymentRequests)
      .set({
        status: "reversed",
        providerPaymentRef: event.paymentRef,
        reversalEventId: event.providerEventId,
        reviewNote: reason,
        reviewedAt,
        updatedAt: reviewedAt,
      })
      .where(and(eq(paymentRequests.id, request.id), eq(paymentRequests.status, previousStatus)))
      .returning();
    if (!reversed) throw new ApiError(409, "paymentCheckoutChanged");

    const auditAfterExtra = {
      provider: providerId,
      paymentRef: event.paymentRef,
      reversalEventId: event.providerEventId,
      kind: event.type,
    };
    if (previousStatus === "pending_payment") {
      await enqueuePaymentProofCleanup(tx, reversed);
      await recordAudit(tx, {
        entityType: "payment_request",
        entityId: reversed.id,
        action: auditAction,
        actor: { type: "system", id: null },
        reason,
        before: { status: "pending_payment" },
        after: { status: "reversed", ...auditAfterExtra },
        correlationId,
      });
      return;
    }

    await applyApprovedPaymentReversal(tx, reversed, {
      actor: { type: "system", id: null },
      reason,
      auditAction,
      correlationId,
      auditAfterExtra,
      notifyMember: true,
    });
  });
}

export async function reversePaymentApproval(
  requestId: string,
  reviewerId: string,
  reason: string,
): Promise<PaymentRequest> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new ApiError(400, "reviewReasonRequired");

  const db = getDb();
  const request = await getPaymentRequest(requestId);
  if (!request) throw new ApiError(404, "paymentRequestNotFound");
  const correlationId = randomUUID();

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(paymentRequests)
      .set({
        status: "reversed",
        reviewNote: trimmedReason,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.status, "approved")))
      .returning();
    if (!updated) throw new ApiError(409, "paymentNotApproved");

    await applyApprovedPaymentReversal(tx, updated, {
      actor: { type: "admin", id: reviewerId },
      reason: trimmedReason,
      auditAction: "reverse",
      correlationId,
      notifyMember: false,
    });
    return updated;
  });
}
