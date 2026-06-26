import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "mail-failure-test-session-secret-long-enough",
    CONFIG_ENCRYPTION_KEY: "mail-failure-test-config-key",
  });
});

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
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
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { requestLoginCode } from "@/modules/auth/login-code";
import { setStoredGroup } from "@/modules/config/store";
import { claimDueTasks } from "@/modules/tasks";
import { dispatchClaimedTask } from "@/modules/tasks/dispatcher";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("auth login-code SMTP failure redaction", () => {
  const db = getDb();

  beforeEach(async () => {
    __resetRateLimitForTests();
    vi.clearAllMocks();
    mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
    await resetDatabase(db);
    await setStoredGroup("smtp", {
      host: "smtp.example.test",
      port: 587,
      secure: false,
      from: "noreply@example.test",
    });
  });

  it("stores only a generic retryable SMTP failure without recipient or code", async () => {
    const rawRecipient = "fan-failure@example.com";
    let leakedCode = "";

    mocks.sendMail.mockImplementation(async (message: { to?: string; text?: string }) => {
      leakedCode = message.text?.match(/[0-9A-HJKMNP-TV-Z]{16}/)?.[0] ?? "";
      throw new Error(
        `550 recipient ${message.to} rejected; rendered body=${message.text}; code=${leakedCode}`,
      );
    });

    await requestLoginCode(rawRecipient, { locale: "en" });
    const [claimed] = await claimDueTasks(1, { lockToken: "mail-failure-worker" });
    expect(claimed).toBeDefined();

    await dispatchClaimedTask(claimed!);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, claimed!.id));
    expect(stored?.status).toBe("failed");
    expect(stored?.lastError).toBe("Email delivery failed");
    expect(leakedCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);

    const loggerArguments = JSON.stringify([
      mocks.loggerInfo.mock.calls,
      mocks.loggerWarn.mock.calls,
      mocks.loggerError.mock.calls,
    ]);
    expect(loggerArguments).not.toContain(rawRecipient);
    expect(loggerArguments).not.toContain(leakedCode);
    expect(stored?.lastError).not.toContain(rawRecipient);
    expect(stored?.lastError).not.toContain(leakedCode);
  });

  it("moves SMTP authentication failures directly to dead with a safe operator warning", async () => {
    const rawRecipient = "fan-auth-failure@example.com";
    mocks.sendMail.mockRejectedValue({
      code: "EAUTH",
      responseCode: 535,
      response: `credentials rejected for ${rawRecipient}; body=private`,
    });

    const requested = await requestLoginCode(rawRecipient, { locale: "en" });
    const [claimed] = await claimDueTasks(1, { lockToken: "mail-auth-worker" });
    await dispatchClaimedTask(claimed!);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, claimed!.id));
    expect(stored).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "SMTP unavailable for login code",
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith("email task dead-lettered", {
      taskId: claimed!.id,
      kind: "auth.login_code_email",
      attempts: 1,
      classification: "needs_operator",
      codeId: requested.codeId,
    });

    const persistedAndLogged = JSON.stringify([
      stored?.lastError,
      mocks.loggerInfo.mock.calls,
      mocks.loggerWarn.mock.calls,
      mocks.loggerError.mock.calls,
    ]);
    expect(persistedAndLogged).not.toContain(rawRecipient);
    expect(persistedAndLogged).not.toContain("body=private");
  });

  it("moves a queued login code directly to dead when SMTP becomes unconfigured", async () => {
    const requested = await requestLoginCode("fan-unconfigured@example.com", { locale: "en" });
    await setStoredGroup("smtp", { host: "", from: "" });
    const [claimed] = await claimDueTasks(1, { lockToken: "mail-unconfigured-worker" });

    await dispatchClaimedTask(claimed!);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, claimed!.id));
    expect(stored).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "SMTP unavailable for login code",
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith("email task dead-lettered", {
      taskId: claimed!.id,
      kind: "auth.login_code_email",
      attempts: 1,
      classification: "needs_operator",
      codeId: requested.codeId,
    });
  });

  it("moves permanent 5xx recipient failures directly to dead", async () => {
    mocks.sendMail.mockRejectedValue({
      code: "EENVELOPE",
      responseCode: 550,
      response: "recipient rejected",
    });

    await requestLoginCode("fan-permanent@example.com", { locale: "en" });
    const [claimed] = await claimDueTasks(1, { lockToken: "mail-permanent-worker" });
    await dispatchClaimedTask(claimed!);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, claimed!.id));
    expect(stored).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "Login code email delivery failed permanently",
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "email task dead-lettered",
      expect.objectContaining({
        taskId: claimed!.id,
        kind: "auth.login_code_email",
        attempts: 1,
        classification: "permanent",
      }),
    );
  });
});
