import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-that-is-long-enough",
    CONFIG_ENCRYPTION_KEY: "test-config-key-for-login-code-delivery",
  });
});

const mocks = vi.hoisted(() => ({
  sendLoginCodeEmail: vi.fn(),
}));

vi.mock("@/modules/mail", () => ({
  sendLoginCodeEmail: mocks.sendLoginCodeEmail,
}));

import { getDb } from "@/db";
import { loginCodes, tasks } from "@/db/schema";
import { hmacSha256WithPurpose } from "@/lib/crypto";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { setStoredGroup } from "@/modules/config/store";
import { claimDueTasks } from "@/modules/tasks";
import { dispatchClaimedTask } from "@/modules/tasks/dispatcher";

import {
  deliverLoginCodeEmailTask,
  type LoginCodeEmailTaskPayload,
  requestLoginCode,
} from "./login-code";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

function payloadOf(task: typeof tasks.$inferSelect): LoginCodeEmailTaskPayload {
  return task.payloadJson as LoginCodeEmailTaskPayload;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describeWithDatabase("S4 persistent login-code delivery fence", () => {
  const db = getDb();

  beforeEach(async () => {
    __resetRateLimitForTests();
    vi.clearAllMocks();
    mocks.sendLoginCodeEmail.mockResolvedValue(undefined);
    await resetDatabase(db);
    // Exercise the real getSmtpConfig() -> getStoredGroup() -> global DB client path.
    await setStoredGroup("smtp", {
      host: "smtp.example.test",
      port: 587,
      secure: false,
      from: "noreply@example.test",
    });
  });

  it("completes at least ten concurrent distinct requests without exhausting the DB pool", async () => {
    const requests = Array.from({ length: 10 }, (_, index) =>
      requestLoginCode(`fan-${index}@example.com`, { locale: "en" }),
    );

    const results = await withTimeout(Promise.all(requests), 5_000);

    expect(results).toHaveLength(10);
    expect(results.every((result) => !result.suppressed)).toBe(true);
    await expect(db.select().from(loginCodes)).resolves.toHaveLength(10);
    await expect(db.select().from(tasks)).resolves.toHaveLength(10);
  }, 10_000);

  it("releases the per-email advisory lock before slow SMTP and suppresses a concurrent resend", async () => {
    const email = "slow@example.com";
    await requestLoginCode(email, { locale: "en" });
    const [claimed] = await claimDueTasks(1, { lockToken: "slow-worker" });
    expect(claimed).toBeDefined();

    let releaseSmtp!: () => void;
    let smtpEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      smtpEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseSmtp = resolve;
    });
    mocks.sendLoginCodeEmail.mockImplementation(async () => {
      smtpEntered();
      await blocked;
    });

    const dispatch = dispatchClaimedTask(claimed!);
    await withTimeout(entered, 2_000);

    const lockResult = await db.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${email})) as acquired`,
    );
    expect(lockResult[0]?.acquired).toBe(true);

    const resend = await requestLoginCode(email, { locale: "en" });
    expect(resend).toEqual({ suppressed: true });
    await expect(db.select().from(loginCodes)).resolves.toHaveLength(1);
    await expect(db.select().from(tasks)).resolves.toHaveLength(1);

    releaseSmtp();
    await withTimeout(dispatch, 2_000);
    const [completed] = await db.select().from(tasks);
    expect(completed?.status).toBe("succeeded");
  }, 10_000);

  it("does not send for a wrong token or an expired lease", async () => {
    await requestLoginCode("fence@example.com", { locale: "en" });
    const [claimed] = await claimDueTasks(1, { lockToken: "current-worker" });
    expect(claimed).toBeDefined();

    await expect(
      deliverLoginCodeEmailTask(payloadOf(claimed!), {
        taskId: claimed!.id,
        lockToken: "wrong-worker",
      }),
    ).resolves.toContain("stale");

    await db
      .update(tasks)
      .set({ leaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, claimed!.id));
    await expect(
      deliverLoginCodeEmailTask(payloadOf(claimed!), {
        taskId: claimed!.id,
        lockToken: "current-worker",
      }),
    ).resolves.toContain("stale");

    expect(mocks.sendLoginCodeEmail).not.toHaveBeenCalled();
  });

  it("allows a reclaimed worker to repeat the same code after a pre-completion crash", async () => {
    await requestLoginCode("retry@example.com", { locale: "en" });
    const [firstClaim] = await claimDueTasks(1, { lockToken: "worker-a" });
    expect(firstClaim).toBeDefined();

    await deliverLoginCodeEmailTask(payloadOf(firstClaim!), {
      taskId: firstClaim!.id,
      lockToken: "worker-a",
    });
    expect(mocks.sendLoginCodeEmail).toHaveBeenCalledTimes(1);
    const firstCode = mocks.sendLoginCodeEmail.mock.calls[0]?.[1];

    await db
      .update(tasks)
      .set({ leaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, firstClaim!.id));
    const [secondClaim] = await claimDueTasks(1, { lockToken: "worker-b" });
    expect(secondClaim?.id).toBe(firstClaim!.id);

    await deliverLoginCodeEmailTask(payloadOf(secondClaim!), {
      taskId: secondClaim!.id,
      lockToken: "worker-b",
    });
    expect(mocks.sendLoginCodeEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendLoginCodeEmail.mock.calls[1]?.[1]).toBe(firstCode);
  });

  it("successfully no-ops a manually retried old task after a newer active code exists", async () => {
    await requestLoginCode("superseded@example.com", { locale: "en" });
    const [oldClaim] = await claimDueTasks(1, { lockToken: "retry-worker" });
    expect(oldClaim).toBeDefined();

    await db.insert(loginCodes).values({
      email: "superseded@example.com",
      codeHash: hmacSha256WithPurpose("auth-login-code", "ZZZZZZZZZZZZZZZZ"),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    await expect(
      deliverLoginCodeEmailTask(payloadOf(oldClaim!), {
        taskId: oldClaim!.id,
        lockToken: "retry-worker",
      }),
    ).resolves.toContain("superseded");
    expect(mocks.sendLoginCodeEmail).not.toHaveBeenCalled();
  });
});
