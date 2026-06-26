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
import { tasks } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { MailDeliveryError } from "@/modules/mail/delivery";
import { claimDueTasks } from "@/modules/tasks";
import { dispatchClaimedTask } from "@/modules/tasks/dispatcher";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const payload = {
  template: "payment_rejected",
  to: "fan@example.com",
  locale: "en",
  params: { tierName: "Supporter", reviewNote: null },
} as const;

describeWithDatabase("business email delivery policy", () => {
  const db = getDb();

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(tasks);
  });

  async function insertAndClaim(createdAt = new Date()) {
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "email",
        payloadJson: payload,
        runAfter: sql`now() - interval '1 second'`,
        createdAt,
      })
      .returning();
    const [claimed] = await claimDueTasks(1, { lockToken: `claim-${created!.id}` });
    return { created: created!, claimed: claimed! };
  }

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
});
