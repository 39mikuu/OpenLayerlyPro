import { and, asc, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  files,
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
import { getSmtpConfig } from "@/modules/config";
import { sendMembershipActivatedEmail, sendPaymentRejectedEmail } from "@/modules/mail";
import { grantMembership } from "@/modules/membership";
import { recordEvent } from "@/modules/system/events";

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

  // 同等级 pending 去重（PRD §10.8）
  const [existing] = await db
    .select()
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.userId, input.userId),
        eq(paymentRequests.tierId, input.tierId),
        eq(paymentRequests.status, "pending_review"),
      ),
    )
    .limit(1);
  if (existing) {
    throw new ApiError(400, "pendingPaymentExists");
  }

  const [request] = await db
    .insert(paymentRequests)
    .values({
      userId: input.userId,
      tierId: input.tierId,
      paymentMethodId: input.paymentMethodId ?? null,
      status: "pending_review",
      amountLabel: tier.priceLabel,
      durationDays: tier.durationDays,
      proofFileId: input.proofFileId ?? null,
      note: input.note ?? null,
    })
    .returning();

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
  const request = await getPaymentRequest(input.requestId);
  if (!request || request.userId !== input.userId) {
    throw new ApiError(404, "paymentRequestNotFound");
  }
  await assertOwnProofFile(input.proofFileId, input.userId);
  // 单语句条件更新作为并发守卫：仅 rejected 状态可重新提交
  const [updated] = await getDb()
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
      ),
    )
    .returning();
  if (!updated) throw new ApiError(400, "resubmitRejectedOnly");
  return updated;
}

export async function cancelPaymentRequest(requestId: string, userId: string): Promise<void> {
  const request = await getPaymentRequest(requestId);
  if (!request || request.userId !== userId) throw new ApiError(404, "paymentRequestNotFound");
  const [updated] = await getDb()
    .update(paymentRequests)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(paymentRequests.id, requestId),
        eq(paymentRequests.userId, userId),
        eq(paymentRequests.status, "pending_review"),
      ),
    )
    .returning();
  if (!updated) throw new ApiError(400, "cancelPendingOnly");
}

export async function approvePaymentRequest(
  requestId: string,
  reviewerId: string,
): Promise<PaymentRequest> {
  const db = getDb();
  const request = await getPaymentRequest(requestId);
  if (!request) throw new ApiError(404, "paymentRequestNotFound");

  // 状态流转与会员开通在同一事务内完成；
  // 条件更新作为并发守卫，重复审核（双击/重试）只会有一次成功
  const { updated, tier, membership } = await db.transaction(async (tx) => {
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

    const granted = await grantMembership(
      {
        userId: row.userId,
        tierId: row.tierId,
        source: "payment_review",
        durationDays: row.durationDays,
        note: `付款申请 ${row.id} 审核通过`,
        createdBy: reviewerId,
      },
      tx,
    );
    return { updated: row, ...granted };
  });

  await recordEvent("payment_request_approved", { requestId, userId: request.userId });

  if ((await getSmtpConfig()).configured) {
    const [user] = await db.select().from(users).where(eq(users.id, request.userId)).limit(1);
    if (user) {
      try {
        await sendMembershipActivatedEmail(user.email, tier.name, membership.endsAt, user.locale);
      } catch (err) {
        logger.error("会员开通邮件发送失败", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return updated;
}

export async function rejectPaymentRequest(
  requestId: string,
  reviewerId: string,
  reviewNote?: string | null,
): Promise<PaymentRequest> {
  const db = getDb();
  const request = await getPaymentRequest(requestId);
  if (!request) throw new ApiError(404, "paymentRequestNotFound");
  const [updated] = await db
    .update(paymentRequests)
    .set({
      status: "rejected",
      reviewNote: reviewNote ?? null,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.status, "pending_review")))
    .returning();
  if (!updated) throw new ApiError(400, "paymentNotPending");

  await recordEvent("payment_request_rejected", { requestId, userId: request.userId });

  if ((await getSmtpConfig()).configured) {
    const [user] = await db.select().from(users).where(eq(users.id, request.userId)).limit(1);
    const [tier] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, request.tierId))
      .limit(1);
    if (user && tier) {
      try {
        await sendPaymentRejectedEmail(user.email, tier.name, reviewNote, user.locale);
      } catch (err) {
        logger.error("驳回邮件发送失败", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return updated;
}
