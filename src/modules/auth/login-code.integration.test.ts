import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmtpConfig: vi.fn(),
  sendLoginCodeEmail: vi.fn(),
}));

vi.mock("@/modules/config", () => ({
  getSmtpConfig: mocks.getSmtpConfig,
}));
vi.mock("@/modules/mail", () => ({
  sendLoginCodeEmail: mocks.sendLoginCodeEmail,
}));

import { getDb } from "@/db";
import { loginCodes, tasks } from "@/db/schema";
import { hmacSha256WithPurpose } from "@/lib/crypto";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { claimDueTasks } from "@/modules/tasks";
import { runTaskHandler } from "@/modules/tasks/handlers";

import { requestLoginCode, verifyLoginCode } from "./login-code";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const LOGIN_CODE_HMAC_PURPOSE = "auth-login-code";
const TEST_CODE = "ABCD1234EFGH5678";

describeWithDatabase("S4 login-code integration", () => {
  const db = getDb();

  beforeEach(async () => {
    __resetRateLimitForTests();
    vi.clearAllMocks();
    mocks.getSmtpConfig.mockResolvedValue({
      configured: true,
      host: "smtp.example.test",
      port: 587,
      secure: false,
      from: "noreply@example.test",
    });
    mocks.sendLoginCodeEmail.mockResolvedValue(undefined);
    await resetDatabase(db);
  });

  it("keeps correct codes usable after wrong attempts and high attempt_count", async () => {
    await db.insert(loginCodes).values({
      email: "fan@example.com",
      codeHash: hmacSha256WithPurpose(LOGIN_CODE_HMAC_PURPOSE, TEST_CODE),
      attemptCount: 50,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    await expect(verifyLoginCode(" fan@example.com ", "0000000000000000")).rejects.toMatchObject({
      status: 400,
      code: "codeIncorrect",
    });
    await expect(verifyLoginCode("FAN@example.com", "1111111111111111")).rejects.toMatchObject({
      status: 400,
      code: "codeIncorrect",
    });

    await expect(verifyLoginCode("Fan@Example.com", TEST_CODE, "zh")).resolves.toMatchObject({
      email: "fan@example.com",
    });

    const [stored] = await db.select().from(loginCodes);
    expect(stored?.attemptCount).toBe(50);
    expect(stored?.usedAt).toBeInstanceOf(Date);
  });

  it("serializes concurrent duplicate requests to one code and one encrypted task", async () => {
    const identity = { kind: "ip", value: "198.51.100.10" } as const;

    const results = await Promise.all([
      requestLoginCode(" Fan@Example.com ", { identity, ip: identity.value, locale: "zh" }),
      requestLoginCode("fan@example.com", { identity, ip: identity.value, locale: "zh" }),
    ]);

    expect(results.filter((result) => result.suppressed)).toHaveLength(1);
    await expect(db.select().from(loginCodes)).resolves.toHaveLength(1);
    const taskRows = await db.select().from(tasks);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.kind).toBe("auth.login_code_email");
    expect(taskRows[0]?.payloadJson).not.toHaveProperty("to");
    expect(JSON.stringify(taskRows[0]?.payloadJson)).not.toContain("fan@example.com");
    expect(mocks.sendLoginCodeEmail).not.toHaveBeenCalled();
  });

  it("suppresses duplicates without minting unseen codes or refreshing the timestamp", async () => {
    const identity = { kind: "ip", value: "198.51.100.20" } as const;

    const first = await requestLoginCode("fan@example.com", { identity, ip: identity.value });
    expect(first.suppressed).toBe(false);
    const [before] = await db.select().from(loginCodes);

    const second = await requestLoginCode(" fan@example.com ", { identity, ip: identity.value });

    const codeRows = await db.select().from(loginCodes);
    const taskRows = await db.select().from(tasks);
    expect(second).toEqual({ suppressed: true });
    expect(codeRows).toHaveLength(1);
    expect(taskRows).toHaveLength(1);
    expect(codeRows[0]?.id).toBe(before?.id);
    expect(codeRows[0]?.createdAt).toEqual(before?.createdAt);
  });

  it("keeps suppressing replacement codes after the dedupe window while delivery is retryable", async () => {
    const identity = { kind: "ip", value: "198.51.100.25" } as const;

    await requestLoginCode("retrying@example.com", { identity, ip: identity.value });
    const [code] = await db.select().from(loginCodes);
    const [task] = await db.select().from(tasks);
    await db
      .update(loginCodes)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(loginCodes.id, code!.id));
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, task!.id));

    await expect(
      requestLoginCode("retrying@example.com", { identity, ip: identity.value }),
    ).resolves.toEqual({ suppressed: true });
    await expect(db.select().from(loginCodes)).resolves.toHaveLength(1);
    await expect(db.select().from(tasks)).resolves.toHaveLength(1);
  });

  it("conservatively suppresses an active code whose durable task is missing", async () => {
    const identity = { kind: "ip", value: "198.51.100.26" } as const;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await requestLoginCode("missing-task@example.com", { identity, ip: identity.value });
    const [code] = await db.select().from(loginCodes);
    await db.delete(tasks);
    await db
      .update(loginCodes)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(loginCodes.id, code!.id));

    await expect(
      requestLoginCode("missing-task@example.com", { identity, ip: identity.value }),
    ).resolves.toEqual({ suppressed: true });
    await expect(db.select().from(loginCodes)).resolves.toHaveLength(1);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("missing-task@example.com");
    warning.mockRestore();
  });

  it("allows a replacement only after terminal delivery and the dedupe window", async () => {
    const identity = { kind: "ip", value: "198.51.100.30" } as const;

    await requestLoginCode("fan@example.com", { identity, ip: identity.value, locale: "zh" });
    const [firstCode] = await db.select().from(loginCodes);
    const [firstTask] = await db.select().from(tasks);
    await db
      .update(loginCodes)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(loginCodes.id, firstCode!.id));
    await db.update(tasks).set({ status: "succeeded" }).where(eq(tasks.id, firstTask!.id));

    const replacement = await requestLoginCode("fan@example.com", {
      identity,
      ip: identity.value,
      locale: "zh",
    });
    expect(replacement.suppressed).toBe(false);

    const taskRows = await db.select().from(tasks).orderBy(asc(tasks.createdAt));
    expect(taskRows).toHaveLength(2);
    const [claimed] = await claimDueTasks(1, { lockToken: "latest-worker" });
    await expect(runTaskHandler(claimed!)).resolves.toEqual({});
    expect(mocks.sendLoginCodeEmail).toHaveBeenCalledOnce();
    const sentCode = mocks.sendLoginCodeEmail.mock.calls[0][1] as string;
    expect(sentCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(JSON.stringify(claimed!.payloadJson)).not.toContain(sentCode);
  });
});
