import { randomUUID } from "crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  files,
  memberships,
  membershipTiers,
  paymentRequests,
  tasks,
  users,
} from "@/db/schema";
import { translate } from "@/modules/i18n";
import { getActiveMembership } from "@/modules/membership";
import {
  formatPaymentRejectionReviewNote,
  parsePaymentRejectionReviewNote,
} from "@/modules/payment/rejection-note";

import {
  approvePaymentRequest,
  cancelPaymentRequest,
  createPaymentRequest,
  rejectPaymentRequest,
  resubmitPaymentProof,
  reversePaymentApproval,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("payment review audit integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(tasks);
    await db.delete(auditEvents);
    await db.delete(paymentRequests);
    await db.delete(memberships);
    await db.delete(files);
    await db.delete(membershipTiers);
    await db.delete(users);
  });

  async function seedRequest(
    status:
      | "pending_review"
      | "pending_payment"
      | "approved"
      | "rejected"
      | "cancelled"
      | "reversed" = "pending_review",
  ) {
    const [user] = await db
      .insert(users)
      .values({ email: `member-${randomUUID()}@example.com` })
      .returning();
    const [admin] = await db
      .insert(users)
      .values({ email: `admin-${randomUUID()}@example.com`, role: "admin" })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Supporter",
        slug: `supporter-${randomUUID()}`,
        priceLabel: "500",
        level: 10,
        durationDays: 31,
      })
      .returning();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        status,
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();
    return { admin, request, tier, user };
  }

  it("allows only one concurrent manual pending request", async () => {
    const { tier, user } = await seedRequest("cancelled");
    const results = await Promise.allSettled([
      createPaymentRequest({ userId: user.id, tierId: tier.id }),
      createPaymentRequest({ userId: user.id, tierId: tier.id }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 400, code: "pendingPaymentExists" });
    const pending = await db
      .select()
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.userId, user.id),
          eq(paymentRequests.tierId, tier.id),
          or(
            eq(paymentRequests.status, "pending_review"),
            eq(paymentRequests.status, "pending_payment"),
          ),
        ),
      );
    expect(pending).toHaveLength(1);
  });

  it("rejects a manual request when an automatic pending request already exists", async () => {
    const { tier, user } = await seedRequest("cancelled");
    await db.insert(paymentRequests).values({
      userId: user.id,
      tierId: tier.id,
      status: "pending_payment",
      flow: "auto",
      provider: "stripe",
      providerRef: `creating:${randomUUID()}`,
      amountLabel: tier.priceLabel,
      durationDays: tier.durationDays,
    });

    await expect(createPaymentRequest({ userId: user.id, tierId: tier.id })).rejects.toMatchObject({
      status: 400,
      code: "pendingPaymentExists",
    });
  });

  it("maps resubmit conflicts to pendingPaymentExists without exposing a unique violation", async () => {
    const { request, tier, user } = await seedRequest("rejected");
    const [proof] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `proof-${randomUUID()}`,
        originalName: "proof.png",
        mimeType: "image/png",
        sizeBytes: 128,
        purpose: "payment_proof",
        createdBy: user.id,
      })
      .returning();
    await db.insert(paymentRequests).values({
      userId: user.id,
      tierId: tier.id,
      status: "pending_payment",
      flow: "auto",
      provider: "stripe",
      providerRef: `creating:${randomUUID()}`,
      amountLabel: tier.priceLabel,
      durationDays: tier.durationDays,
    });

    await expect(
      resubmitPaymentProof({ requestId: request.id, userId: user.id, proofFileId: proof.id }),
    ).rejects.toMatchObject({ status: 400, code: "pendingPaymentExists" });
    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    expect(stored?.status).toBe("rejected");
  });

  it("serializes create against resubmit so exactly one request becomes pending", async () => {
    const { request, tier, user } = await seedRequest("rejected");
    const [proof] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `proof-${randomUUID()}`,
        originalName: "proof.png",
        mimeType: "image/png",
        sizeBytes: 128,
        purpose: "payment_proof",
        createdBy: user.id,
      })
      .returning();
    const results = await Promise.allSettled([
      createPaymentRequest({ userId: user.id, tierId: tier.id }),
      resubmitPaymentProof({ requestId: request.id, userId: user.id, proofFileId: proof.id }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 400, code: "pendingPaymentExists" });

    const pending = await db
      .select()
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.userId, user.id),
          eq(paymentRequests.tierId, tier.id),
          or(
            eq(paymentRequests.status, "pending_review"),
            eq(paymentRequests.status, "pending_payment"),
          ),
        ),
      );
    expect(pending).toHaveLength(1);
  });

  it("serializes two administrators approving separate grants for one user", async () => {
    const { admin, request, tier, user } = await seedRequest();
    const [secondAdmin] = await db
      .insert(users)
      .values({ email: `admin-${randomUUID()}@example.com`, role: "admin" })
      .returning();
    const [secondTier] = await db
      .insert(membershipTiers)
      .values({
        name: "Supporter alternate",
        slug: `supporter-alt-${randomUUID()}`,
        priceLabel: "500",
        level: tier.level,
        durationDays: 31,
      })
      .returning();
    const [secondRequest] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: secondTier.id,
        status: "pending_review",
        amountLabel: secondTier.priceLabel,
        durationDays: secondTier.durationDays,
      })
      .returning();

    await Promise.all([
      approvePaymentRequest(request.id, admin.id),
      approvePaymentRequest(secondRequest.id, secondAdmin.id),
    ]);
    const grants = (
      await db.select().from(memberships).where(eq(memberships.userId, user.id))
    ).sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
    expect(grants).toHaveLength(2);
    expect(grants[1]!.startsAt.toISOString()).toBe(grants[0]!.endsAt.toISOString());
    expect(grants[1]!.endsAt.getTime() - grants[0]!.startsAt.getTime()).toBe(
      62 * 24 * 60 * 60 * 1000,
    );
  });

  it("approves once under concurrency and links the membership grant causally", async () => {
    const { admin, request, user } = await seedRequest();
    const results = await Promise.allSettled([
      approvePaymentRequest(request.id, admin.id),
      approvePaymentRequest(request.id, admin.id),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof approvePaymentRequest>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 400, code: "paymentNotPending" });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const grants = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    const [approveEvent] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, request.id), eq(auditEvents.action, "approve")));
    const [grantEvent] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "membership"), eq(auditEvents.action, "grant")));

    expect(grants).toHaveLength(1);
    expect(stored).toMatchObject({
      status: "approved",
      grantedMembershipId: grants[0]?.id,
    });
    expect(approveEvent).toMatchObject({
      actorType: "admin",
      actorId: admin.id,
      beforeJson: { status: "pending_review" },
      afterJson: { status: "approved" },
    });
    expect(grantEvent).toMatchObject({
      correlationId: approveEvent?.correlationId,
      causationId: approveEvent?.id,
    });
    const queued = await db.select().from(tasks);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "email",
      dedupeKey: `email:membership_activated:${request.id}`,
      status: "pending",
      payloadJson: {
        template: "membership_activated",
        to: user.email,
        locale: user.locale,
      },
    });
  });

  it("reverses an approval once and revokes the exact granted membership", async () => {
    const { admin, request, user } = await seedRequest();
    const approved = await approvePaymentRequest(request.id, admin.id);
    if (!approved.grantedMembershipId) throw new Error("granted membership link missing");

    const reversed = await reversePaymentApproval(request.id, admin.id, "duplicate transfer");
    expect(reversed.status).toBe("reversed");
    await expect(getActiveMembership(user.id)).resolves.toBeNull();

    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, approved.grantedMembershipId));
    const [reverseEvent] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, request.id), eq(auditEvents.action, "reverse")));
    const [revokeEvent] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, approved.grantedMembershipId),
          eq(auditEvents.action, "revoke"),
        ),
      );

    expect(membership).toMatchObject({ status: "revoked", version: 1 });
    expect(reverseEvent).toMatchObject({
      reason: "duplicate transfer",
      actorType: "admin",
      actorId: admin.id,
    });
    expect(revokeEvent).toMatchObject({
      correlationId: reverseEvent?.correlationId,
      causationId: reverseEvent?.id,
    });
    await expect(reversePaymentApproval(request.id, admin.id, "retry")).rejects.toMatchObject({
      status: 409,
      code: "paymentNotApproved",
    });
  });

  it("refuses to reverse an approval without a membership grant link", async () => {
    const { admin, request, tier, user } = await seedRequest("approved");
    const [membership] = await db
      .insert(memberships)
      .values({
        userId: user.id,
        tierId: tier.id,
        source: "payment_review",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        status: "active",
        createdBy: admin.id,
      })
      .returning();

    await expect(
      reversePaymentApproval(request.id, admin.id, "legacy approval"),
    ).rejects.toMatchObject({
      status: 409,
      code: "paymentGrantLinkMissing",
    });

    const [storedRequest] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const [storedMembership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, membership.id));
    const reverseEvents = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, request.id), eq(auditEvents.action, "reverse")));

    expect(storedRequest?.status).toBe("approved");
    expect(storedMembership).toMatchObject({ status: "active", version: 0 });
    expect(reverseEvents).toHaveLength(0);
  });

  it("audits reject, resubmit, and cancel with the correct actors", async () => {
    const rejectedSeed = await seedRequest();
    const rejected = await rejectPaymentRequest(
      rejectedSeed.request.id,
      rejectedSeed.admin.id,
      "proof is unclear",
    );
    const [proof] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `proof-${randomUUID()}`,
        originalName: "proof.png",
        mimeType: "image/png",
        sizeBytes: 128,
        purpose: "payment_proof",
        createdBy: rejectedSeed.user.id,
      })
      .returning();
    await resubmitPaymentProof({
      requestId: rejected.id,
      userId: rejectedSeed.user.id,
      proofFileId: proof.id,
    });

    const cancelSeed = await seedRequest();
    await cancelPaymentRequest(cancelSeed.request.id, cancelSeed.user.id);

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityType, "payment_request"));
    const rejectEvent = events.find((event) => event.action === "reject");
    const resubmitEvent = events.find((event) => event.action === "resubmit");
    const cancelEvent = events.find((event) => event.action === "cancel");

    expect(rejectEvent).toMatchObject({
      actorType: "admin",
      actorId: rejectedSeed.admin.id,
      reason: "proof is unclear",
    });
    expect(resubmitEvent).toMatchObject({
      actorType: "user",
      actorId: rejectedSeed.user.id,
      beforeJson: { status: "rejected", proofFileId: null },
      afterJson: { status: "pending_review", proofFileId: proof.id },
    });
    expect(cancelEvent).toMatchObject({
      actorType: "user",
      actorId: cancelSeed.user.id,
      beforeJson: { status: "pending_review" },
      afterJson: { status: "cancelled" },
    });
    const [rejectionTask] = await db.select().from(tasks).where(eq(tasks.kind, "email"));
    expect(rejectionTask).toMatchObject({
      status: "pending",
      payloadJson: {
        template: "payment_rejected",
        to: rejectedSeed.user.email,
        locale: rejectedSeed.user.locale,
        params: {
          tierName: rejectedSeed.tier.name,
          reviewNote: "proof is unclear",
        },
      },
    });
  });

  it("stores structured rejection reasons as stable codes and defers localization", async () => {
    const seeded = await seedRequest();
    const rejected = await rejectPaymentRequest(seeded.request.id, seeded.admin.id, {
      rejectReasonCode: "proof_unclear",
      rejectDetails: "Upload the receipt number.",
    });

    expect(rejected.reviewNote).toBeTruthy();
    expect(rejected.reviewNote).not.toContain("Payment proof is unclear");
    expect(rejected.reviewNote).not.toContain("付款凭证不清晰");
    expect(parsePaymentRejectionReviewNote(rejected.reviewNote)).toMatchObject({
      kind: "structured",
      rejectReasonCode: "proof_unclear",
      rejectDetails: "Upload the receipt number.",
    });
    expect(
      formatPaymentRejectionReviewNote(rejected.reviewNote, (key, params) =>
        translate("en", key, params),
      ),
    ).toBe("Payment proof is unclear or incomplete: Upload the receipt number.");
    expect(
      formatPaymentRejectionReviewNote(rejected.reviewNote, (key, params) =>
        translate("zh", key, params),
      ),
    ).toBe("付款凭证不清晰或信息不足: Upload the receipt number.");

    const [rejectEvent] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, seeded.request.id), eq(auditEvents.action, "reject")));
    expect(rejectEvent).toMatchObject({ reason: "proof_unclear: Upload the receipt number." });

    const [rejectionTask] = await db.select().from(tasks).where(eq(tasks.kind, "email"));
    expect(rejectionTask?.payloadJson).toMatchObject({
      template: "payment_rejected",
      params: { tierName: seeded.tier.name, reviewNote: rejected.reviewNote },
    });
  });

  it("rolls back approval when its audit event cannot be inserted", async () => {
    const { admin, request, user } = await seedRequest();
    await db.execute(
      sql.raw(`
      create function fail_payment_approve_audit() returns trigger as $$
      begin
        if new.entity_type = 'payment_request' and new.action = 'approve' then
          raise exception 'forced payment audit failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger fail_payment_approve_audit_trigger
      before insert on audit_events
      for each row execute function fail_payment_approve_audit();
    `),
    );

    try {
      await expect(approvePaymentRequest(request.id, admin.id)).rejects.toThrow();
    } finally {
      await db.execute(
        sql.raw(`
        drop trigger if exists fail_payment_approve_audit_trigger on audit_events;
        drop function if exists fail_payment_approve_audit();
      `),
      );
    }

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const grants = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, request.id));
    const queued = await db.select().from(tasks);
    expect(stored).toMatchObject({ status: "pending_review", grantedMembershipId: null });
    expect(grants).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rolls back approval and membership grant when outbox enqueue fails", async () => {
    const { admin, request, user } = await seedRequest();
    await db.execute(
      sql.raw(`
      create function fail_email_task_enqueue() returns trigger as $$
      begin
        if new.kind = 'email' then
          raise exception 'forced outbox failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger fail_email_task_enqueue_trigger
      before insert on tasks
      for each row execute function fail_email_task_enqueue();
    `),
    );

    try {
      await expect(approvePaymentRequest(request.id, admin.id)).rejects.toThrow();
    } finally {
      await db.execute(
        sql.raw(`
        drop trigger if exists fail_email_task_enqueue_trigger on tasks;
        drop function if exists fail_email_task_enqueue();
      `),
      );
    }

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const grants = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, request.id));
    const queued = await db.select().from(tasks);
    expect(stored).toMatchObject({ status: "pending_review", grantedMembershipId: null });
    expect(grants).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rolls back reversal when membership revoke auditing fails", async () => {
    const { admin, request } = await seedRequest();
    const approved = await approvePaymentRequest(request.id, admin.id);
    if (!approved.grantedMembershipId) throw new Error("granted membership link missing");

    await db.execute(
      sql.raw(`
      create function fail_membership_revoke_audit() returns trigger as $$
      begin
        if new.entity_type = 'membership' and new.action = 'revoke' then
          raise exception 'forced membership audit failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger fail_membership_revoke_audit_trigger
      before insert on audit_events
      for each row execute function fail_membership_revoke_audit();
    `),
    );

    try {
      await expect(
        reversePaymentApproval(request.id, admin.id, "must roll back"),
      ).rejects.toThrow();
    } finally {
      await db.execute(
        sql.raw(`
        drop trigger if exists fail_membership_revoke_audit_trigger on audit_events;
        drop function if exists fail_membership_revoke_audit();
      `),
      );
    }

    const [storedRequest] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const [storedMembership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, approved.grantedMembershipId));
    const reverseEvents = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, request.id), eq(auditEvents.action, "reverse")));

    expect(storedRequest?.status).toBe("approved");
    expect(storedMembership).toMatchObject({ status: "active", version: 0 });
    expect(reverseEvents).toHaveLength(0);
  });
});
