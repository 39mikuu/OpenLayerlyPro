import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "email-delivery-integration-secret-long-enough",
  });
});

const mocks = vi.hoisted(() => ({
  sendMembershipActivatedEmail: vi.fn(),
  sendMembershipRevokedEmail: vi.fn(),
  sendPaymentRejectedEmail: vi.fn(),
  sendRenewalReminderEmail: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/modules/mail", () => ({
  sendMembershipActivatedEmail: mocks.sendMembershipActivatedEmail,
  sendMembershipRevokedEmail: mocks.sendMembershipRevokedEmail,
  sendPaymentRejectedEmail: mocks.sendPaymentRejectedEmail,
  sendRenewalReminderEmail: mocks.sendRenewalReminderEmail,
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import { getDb } from "@/db";
import { membershipTiers, paymentRequests, tasks, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { MailDeliveryError } from "@/modules/mail/delivery";
import { claimDueTasks } from "@/modules/tasks";
import { dispatchClaimedTask } from "@/modules/tasks/dispatcher";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("business email delivery policy", () => {
  const db = getDb();

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDatabase(db);
  });

  async function seedRejectedPaymentRequest() {
    const [user] = await db
      .insert(users)
      .values({ email: `fan-${randomUUID()}@example.test`, locale: "en" })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Supporter",
        slug: `supporter-${randomUUID()}`,
        priceLabel: "$5",
        level: 10,
        durationDays: 31,
      })
      .returning();
    const reviewedAt = new Date("2026-07-12T10:00:00.000Z");
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user!.id,
        tierId: tier!.id,
        status: "rejected",
        amountLabel: tier!.priceLabel,
        durationDays: tier!.durationDays,
        reviewNote: "Proof unclear",
        reviewedAt,
      })
      .returning();
    return { request: request!, reviewedAt, tier: tier!, user: user! };
  }

  async function insertAndClaim(createdAt = new Date()) {
    const { request, reviewedAt, user } = await seedRejectedPaymentRequest();
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "email",
        payloadJson: {
          version: 2,
          template: "payment_rejected",
          paymentRequestId: request.id,
          reviewedAt: reviewedAt.toISOString(),
        },
        runAfter: sql`now() - interval '1 second'`,
        createdAt,
      })
      .returning();
    const [claimed] = await claimDueTasks(1, { lockToken: `claim-${created!.id}` });
    return { created: created!, claimed: claimed!, request, reviewedAt, user };
  }

  it("dereferences latest user email and locale at send time", async () => {
    mocks.sendPaymentRejectedEmail.mockResolvedValue(undefined);
    const { claimed, user } = await insertAndClaim();
    await db
      .update(users)
      .set({ email: `latest-${randomUUID()}@example.test`, locale: "ja" })
      .where(eq(users.id, user.id));

    await dispatchClaimedTask(claimed);

    const [latestUser] = await db.select().from(users).where(eq(users.id, user.id));
    expect(mocks.sendPaymentRejectedEmail).toHaveBeenCalledWith(
      latestUser!.email,
      "Supporter",
      "Proof unclear",
      "ja",
    );
    expect(JSON.stringify(claimed.payloadJson)).not.toContain(latestUser!.email);
  });

  it("defers missing SMTP without consuming the claimed attempt", async () => {
    mocks.sendPaymentRejectedEmail.mockRejectedValue(new ApiError(500, "mailNotConfigured"));
    const before = Date.now();
    const { created, claimed } = await insertAndClaim();

    await dispatchClaimedTask(claimed);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, created.id));
    expect(stored).toMatchObject({
      status: "pending",
      attempts: 0,
      lockedBy: null,
      lastError: null,
    });
    expect(stored!.runAfter.getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1_000);
    expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
      "email task dead-lettered",
      expect.anything(),
    );
  });

  it("moves an over-age operator-blocked email directly to dead", async () => {
    mocks.sendPaymentRejectedEmail.mockRejectedValue(new ApiError(500, "mailNotConfigured"));
    const { created, claimed } = await insertAndClaim(new Date(Date.now() - 25 * 60 * 60 * 1_000));

    await dispatchClaimedTask(claimed);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, created.id));
    expect(stored).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "SMTP unavailable; email expired after 24 h",
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith("email task dead-lettered", {
      taskId: created.id,
      kind: "email",
      attempts: 1,
      classification: "needs_operator",
    });
  });

  it("moves permanent SMTP failures to dead on the first attempt", async () => {
    mocks.sendPaymentRejectedEmail.mockRejectedValue(new MailDeliveryError("permanent"));
    const { created, claimed } = await insertAndClaim();

    await dispatchClaimedTask(claimed);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, created.id));
    expect(stored).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "Email delivery failed permanently",
    });
  });

  it("keeps transient SMTP failures retryable and persists only a safe summary", async () => {
    mocks.sendPaymentRejectedEmail.mockRejectedValue(
      new Error("fan@example.com rejected; rendered body=private"),
    );
    const { created, claimed } = await insertAndClaim();

    await dispatchClaimedTask(claimed);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, created.id));
    expect(stored).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Email delivery failed",
    });
    expect(stored!.lastError).not.toContain("fan@example.com");
    expect(stored!.lastError).not.toContain("body=private");
    expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
      "email task dead-lettered",
      expect.anything(),
    );
  });

  it("dead-letters safely when the referenced user is gone", async () => {
    const { created, claimed, user } = await insertAndClaim();
    await db.delete(users).where(eq(users.id, user.id));

    await dispatchClaimedTask(claimed);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, created.id));
    expect(stored).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "Transactional email domain reference is stale or missing",
    });
    expect(JSON.stringify(stored!.payloadJson)).not.toContain("@");
    expect(mocks.sendPaymentRejectedEmail).not.toHaveBeenCalled();
  });
});
