import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  files,
  memberships,
  membershipTiers,
  paymentRequests,
  users,
} from "@/db/schema";
import { getActiveMembership } from "@/modules/membership";

import {
  approvePaymentRequest,
  cancelPaymentRequest,
  rejectPaymentRequest,
  resubmitPaymentProof,
  reversePaymentApproval,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("payment review audit integration", () => {
  const db = getDb();

  beforeEach(async () => {
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
    expect(stored).toMatchObject({ status: "pending_review", grantedMembershipId: null });
    expect(grants).toHaveLength(0);
    expect(events).toHaveLength(0);
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
