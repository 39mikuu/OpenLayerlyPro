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
    expect(stored?.lastError).toBe("Error: SMTP delivery failed");
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
});
