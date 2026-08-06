import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmtpConfig: vi.fn(),
  sendMagicLinkEmail: vi.fn(),
  sendMagicLinkEmailWithDeadline: vi.fn(),
}));

vi.mock("@/modules/config", () => ({
  getSmtpConfig: mocks.getSmtpConfig,
}));
vi.mock("@/modules/mail", () => ({
  sendMagicLinkEmail: mocks.sendMagicLinkEmail,
  sendMagicLinkEmailWithDeadline: mocks.sendMagicLinkEmailWithDeadline,
}));
vi.mock("@/modules/security/magic-link-key", () => {
  const keyring = {
    current: { keyId: "k2", secret: "current-secret-32-bytes-long!!!!" },
    previous: { keyId: "k1", secret: "previous-secret-32-bytes-long!!!" },
  };
  return {
    tryGetMagicLinkKeys: () => keyring,
    getMagicLinkKeys: () => keyring,
    resetMagicLinkKeyCacheForTests: () => undefined,
  };
});

import { getDb } from "@/db";
import { appEvents, magicLinkTokens, sessions, tasks, users } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { getMagicLinkKeys } from "@/modules/security/magic-link-key";
import { claimDueTasks } from "@/modules/tasks";
import { runTaskHandler } from "@/modules/tasks/handlers";

import {
  consumeMagicLinkToken,
  generateMagicLinkToken,
  requestMagicLink,
  verifyMagicLinkToken,
} from "./magic-link";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const identity = { kind: "ip", value: "198.51.100.77" } as const;

async function insertToken(input: {
  key: { keyId: string; secret: string };
  email: string;
  expiresAt?: Date;
  consumedAt?: Date | null;
  redirectPath?: string | null;
}): Promise<{ token: string; id: string }> {
  const generated = generateMagicLinkToken(input.key);
  const [row] = await getDb()
    .insert(magicLinkTokens)
    .values({
      email: input.email,
      tokenHash: generated.tokenHash,
      keyId: generated.keyId,
      redirectPath: input.redirectPath ?? null,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60_000),
      consumedAt: input.consumedAt ?? null,
    })
    .returning({ id: magicLinkTokens.id });
  return { token: generated.token, id: row.id };
}

async function removeSessionInsertFailure(): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(
      sql`drop trigger if exists olp_test_fail_magic_link_session_insert on sessions`,
    );
    await tx.execute(sql`drop function if exists olp_test_fail_magic_link_session_insert()`);
  });
}

async function installSessionInsertFailure(): Promise<void> {
  await removeSessionInsertFailure();
  await getDb().execute(sql`
    create function olp_test_fail_magic_link_session_insert()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception 'test magic link session insert failure';
    end
    $$
  `);
  await getDb().execute(sql`
    create trigger olp_test_fail_magic_link_session_insert
    before insert on sessions
    for each row execute function olp_test_fail_magic_link_session_insert()
  `);
}

async function removeSessionHandoffConstraint(): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(
      sql`alter table sessions drop constraint if exists olp_test_reject_handoff_holder`,
    );
  });
}

describeWithDatabase("WP1 magic link integration", () => {
  const db = getDb();
  const raw = postgres(getEnv().DATABASE_URL, { max: 4, onnotice: () => {} });

  async function waitForBlockedQuery(queryPattern: string, blockerPid: number): Promise<number> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [activity] = await raw<{ pid: number }[]>`
        select pid::integer as pid
          from pg_stat_activity
         where datname = current_database()
           and wait_event_type = 'Lock'
           and query ilike ${queryPattern}
           and ${blockerPid} = any(pg_blocking_pids(pid))
         order by query_start desc
         limit 1
      `;
      if (activity) return activity.pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no backend waited for blocker ${blockerPid}: ${queryPattern}`);
  }

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
    mocks.sendMagicLinkEmail.mockResolvedValue(undefined);
    mocks.sendMagicLinkEmailWithDeadline.mockResolvedValue(undefined);
    await removeSessionInsertFailure();
    await removeSessionHandoffConstraint();
    await resetDatabase(db);
  });

  afterAll(async () => {
    try {
      await removeSessionInsertFailure();
      await removeSessionHandoffConstraint();
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("stores only a keyed hash and an encrypted task payload, never the raw token", async () => {
    const result = await requestMagicLink(" Fan@Example.com ", {
      identity,
      ip: identity.value,
      locale: "zh",
      redirectPath: "/posts/hello?from=mail",
    });
    expect(result.suppressed).toBe(false);

    const [row] = await db.select().from(magicLinkTokens);
    expect(row.email).toBe("fan@example.com");
    expect(row.keyId).toBe("k2");
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.consumedAt).toBeNull();
    expect(row.redirectPath).toBe("/posts/hello");
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1_000);

    const taskRows = await db.select().from(tasks);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].kind).toBe("auth.magic_link_email");
    const payloadText = JSON.stringify(taskRows[0].payloadJson);
    expect(payloadText).not.toContain("olp_mlk.");
    expect(payloadText).not.toContain("fan@example.com");
    expect(payloadText).not.toContain(row.tokenHash);
  });

  it("serializes concurrent duplicate requests into one token and one task", async () => {
    const results = await Promise.all([
      requestMagicLink("fan@example.com", { identity, ip: identity.value }),
      requestMagicLink(" FAN@example.com ", { identity, ip: identity.value }),
    ]);

    expect(results.filter((result) => result.suppressed)).toHaveLength(1);
    await expect(db.select().from(magicLinkTokens)).resolves.toHaveLength(1);
    await expect(db.select().from(tasks)).resolves.toHaveLength(1);
  });

  it("does not mint a token or a delivery task for an admin mailbox", async () => {
    const originalLastLoginAt = new Date("2025-01-02T03:04:05.000Z");
    const originalUpdatedAt = new Date("2025-01-02T03:04:05.000Z");
    const [admin] = await db
      .insert(users)
      .values({
        email: "boss@example.com",
        role: "admin",
        passwordHash: "test-password-hash",
        locale: "en",
        lastLoginAt: originalLastLoginAt,
        updatedAt: originalUpdatedAt,
      })
      .returning();

    await expect(
      requestMagicLink(" Boss@Example.com ", {
        identity,
        ip: identity.value,
        locale: "zh",
      }),
    ).resolves.toEqual({ suppressed: true });
    await expect(db.select().from(magicLinkTokens)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
    await expect(db.select().from(appEvents)).resolves.toHaveLength(0);

    const [after] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(after).toMatchObject({ role: "admin", locale: "en" });
    expect(after.lastLoginAt).toEqual(originalLastLoginAt);
    expect(after.updatedAt).toEqual(originalUpdatedAt);
  });

  it("serializes concurrent admin requests without minting a token or task", async () => {
    await db.insert(users).values({
      email: "concurrent-admin-request@example.com",
      role: "admin",
      passwordHash: "test-password-hash",
    });

    const results = await Promise.all([
      requestMagicLink("concurrent-admin-request@example.com", {
        identity,
        ip: identity.value,
      }),
      requestMagicLink(" Concurrent-Admin-Request@Example.com ", {
        identity,
        ip: identity.value,
      }),
    ]);

    expect(results).toEqual([{ suppressed: true }, { suppressed: true }]);
    await expect(db.select().from(magicLinkTokens)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("does not spend the email and IP send budget for an admin mailbox", async () => {
    const [admin] = await db
      .insert(users)
      .values({
        email: "budget-admin@example.com",
        role: "admin",
        passwordHash: "test-password-hash",
      })
      .returning();

    const attempts = getEnv().REQUEST_CODE_EMAIL_IP_RATE_MAX + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await expect(
        requestMagicLink(" Budget-Admin@Example.com ", {
          identity,
          ip: identity.value,
        }),
      ).resolves.toEqual({ suppressed: true });
    }
    await expect(db.select().from(magicLinkTokens)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);

    await db.update(users).set({ role: "member" }).where(eq(users.id, admin.id));
    await expect(
      requestMagicLink(admin.email, { identity, ip: identity.value }),
    ).resolves.toMatchObject({ suppressed: false });
    await expect(db.select().from(magicLinkTokens)).resolves.toHaveLength(1);
    await expect(db.select().from(tasks)).resolves.toHaveLength(1);
  });

  it("keeps suppressing replacement links while the delivery task is retryable", async () => {
    await requestMagicLink("retry@example.com", { identity, ip: identity.value });
    const [row] = await db.select().from(magicLinkTokens);
    const [task] = await db.select().from(tasks);
    await db
      .update(magicLinkTokens)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(magicLinkTokens.id, row.id));
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, task.id));

    await expect(
      requestMagicLink("retry@example.com", { identity, ip: identity.value }),
    ).resolves.toEqual({ suppressed: true });
    await expect(db.select().from(magicLinkTokens)).resolves.toHaveLength(1);
  });

  it("expires older unconsumed tokens when a replacement link is minted after the dedupe window", async () => {
    // Deliver the first link so the delivery fence no longer suppresses replacements.
    await requestMagicLink("replace@example.com", { identity, ip: identity.value });
    const [firstRow] = await db.select().from(magicLinkTokens);
    const [firstTask] = await db.select().from(tasks);
    const [claimed] = await claimDueTasks(1, { lockToken: "magic-supersede-worker" });
    await expect(runTaskHandler(claimed!)).resolves.toEqual({});
    expect(mocks.sendMagicLinkEmail).toHaveBeenCalledTimes(1);
    const firstConfirmUrl = mocks.sendMagicLinkEmail.mock.calls[0][1] as string;
    const firstToken = firstConfirmUrl.slice(
      firstConfirmUrl.lastIndexOf("/login/magic/") + "/login/magic/".length,
    );

    // Age the first token past the send-dedupe window and mark delivery done so a
    // second request is allowed to mint a replacement (same path as a real user
    // requesting another link after the first mail already went out).
    await db
      .update(magicLinkTokens)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(magicLinkTokens.id, firstRow.id));
    await db.update(tasks).set({ status: "succeeded" }).where(eq(tasks.id, firstTask.id));

    const second = await requestMagicLink("replace@example.com", {
      identity,
      ip: identity.value,
    });
    expect(second.suppressed).toBe(false);
    expect(second.tokenId).toBeTruthy();

    const rows = await db.select().from(magicLinkTokens);
    expect(rows).toHaveLength(2);
    const older = rows.find((row) => row.id === firstRow.id)!;
    const newer = rows.find((row) => row.id === second.tokenId)!;
    expect(older.consumedAt).toBeNull();
    expect(older.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(newer.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

    // Older already-delivered link must not verify or log in after supersession.
    await expect(verifyMagicLinkToken(firstToken)).resolves.toEqual({ status: "expired" });
    await expect(consumeMagicLinkToken(firstToken)).resolves.toEqual({ status: "expired" });
    await expect(db.select().from(users)).resolves.toHaveLength(0);

    // Deliver and consume the replacement link.
    const [claimedSecond] = await claimDueTasks(1, { lockToken: "magic-supersede-worker-2" });
    await expect(runTaskHandler(claimedSecond!)).resolves.toEqual({});
    const secondConfirmUrl = mocks.sendMagicLinkEmail.mock.calls[1][1] as string;
    const secondToken = secondConfirmUrl.slice(
      secondConfirmUrl.lastIndexOf("/login/magic/") + "/login/magic/".length,
    );
    await expect(consumeMagicLinkToken(secondToken)).resolves.toMatchObject({
      status: "consumed",
      user: expect.objectContaining({ email: "replace@example.com" }),
    });
  });

  it("delivers a confirm URL whose token verifies without being consumed, then single-use consumes", async () => {
    await requestMagicLink("fan@example.com", { identity, ip: identity.value, locale: "ja" });

    const [claimed] = await claimDueTasks(1, { lockToken: "magic-worker" });
    await expect(runTaskHandler(claimed!)).resolves.toEqual({});
    expect(mocks.sendMagicLinkEmail).toHaveBeenCalledTimes(1);
    const [to, confirmUrl, locale] = mocks.sendMagicLinkEmail.mock.calls[0];
    expect(to).toBe("fan@example.com");
    expect(locale).toBe("ja");
    expect(confirmUrl).toContain("/login/magic/olp_mlk.v1.k2.");
    const token = confirmUrl.slice(
      confirmUrl.lastIndexOf("/login/magic/") + "/login/magic/".length,
    );

    // Mail-client prefetch repeatedly hits the non-consuming verification.
    await expect(verifyMagicLinkToken(token)).resolves.toMatchObject({ status: "valid" });
    await expect(verifyMagicLinkToken(token)).resolves.toMatchObject({ status: "valid" });
    const [beforeConsume] = await db.select().from(magicLinkTokens);
    expect(beforeConsume.consumedAt).toBeNull();

    const consumption = await consumeMagicLinkToken(token, {
      locale: "ja",
      ip: "198.51.100.25",
      userAgent: "magic-link-integration-test",
    });
    expect(consumption.status).toBe("consumed");
    if (consumption.status !== "consumed") throw new Error("unreachable");
    expect(consumption.user.email).toBe("fan@example.com");
    expect(consumption.redirectPath).toBeNull();
    expect(consumption.session.token).toBeTruthy();

    const [member] = await db.select().from(users).where(eq(users.email, "fan@example.com"));
    expect(member.role).toBe("member");
    const [session] = await db.select().from(sessions).where(eq(sessions.userId, member.id));
    expect(session).toMatchObject({
      ip: "198.51.100.25",
      userAgent: "magic-link-integration-test",
    });

    // Replay after consumption fails closed, and the row stays consumed once.
    await expect(consumeMagicLinkToken(token)).resolves.toEqual({ status: "replayed" });
    await expect(verifyMagicLinkToken(token)).resolves.toEqual({ status: "replayed" });
  });

  it("burns the link without creating a session when the member was promoted after issuance", async () => {
    const originalLastLoginAt = new Date("2025-01-02T03:04:05.000Z");
    const originalUpdatedAt = new Date("2025-01-02T03:04:05.000Z");
    const [user] = await db
      .insert(users)
      .values({
        email: "promoted@example.com",
        role: "member",
        locale: "en",
        lastLoginAt: originalLastLoginAt,
        updatedAt: originalUpdatedAt,
      })
      .returning();
    const { token, id } = await insertToken({
      key: getMagicLinkKeys().current,
      email: user.email,
      redirectPath: "/posts/admin-boundary",
    });
    await db
      .update(users)
      .set({ role: "admin", updatedAt: originalUpdatedAt })
      .where(eq(users.id, user.id));

    await expect(
      consumeMagicLinkToken(token, {
        locale: "ja",
        ip: "198.51.100.41",
        userAgent: "admin-boundary-test",
      }),
    ).resolves.toEqual({ status: "invalid" });

    const [storedToken] = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.id, id));
    expect(storedToken.consumedAt).not.toBeNull();
    await expect(db.select().from(sessions)).resolves.toHaveLength(0);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after).toMatchObject({ role: "admin", locale: "en" });
    expect(after.lastLoginAt).toEqual(originalLastLoginAt);
    expect(after.updatedAt).toEqual(originalUpdatedAt);

    const events = await db.select().from(appEvents);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.type).toBe("magic_link_rejected");
    expect(event.payloadJson).toEqual({
      reason: "invalid",
      boundary: "admin",
      tokenId: id,
      keyId: "k2",
      userId: user.id,
    });
    const eventText = JSON.stringify(event.payloadJson);
    expect(eventText).not.toContain(token);
    expect(eventText).not.toContain(storedToken.tokenHash);
    expect(eventText).not.toContain(user.email);
    expect(eventText).not.toContain("198.51.100.41");
    expect(eventText).not.toContain("admin-boundary-test");
    expect(eventText).not.toContain("/posts/admin-boundary");

    await expect(consumeMagicLinkToken(token)).resolves.toEqual({ status: "replayed" });
    await expect(db.select().from(sessions)).resolves.toHaveLength(0);
  });

  it(
    "waits for an in-flight promotion before rejecting the promoted admin",
    { timeout: 15_000 },
    async () => {
      const [member] = await db
        .insert(users)
        .values({ email: "promotion-lock@example.com", role: "member" })
        .returning();
      const { token, id } = await insertToken({
        key: getMagicLinkKeys().current,
        email: member.email,
      });
      const controller = await raw.reserve();
      let consumption: ReturnType<typeof consumeMagicLinkToken> | undefined;
      try {
        await controller`begin`;
        const [controllerBackend] = await controller<
          { pid: number }[]
        >`select pg_backend_pid()::integer as pid`;
        await controller`update users set role = 'admin' where id = ${member.id}`;

        consumption = consumeMagicLinkToken(token);
        await waitForBlockedQuery("%for no key update%", controllerBackend.pid);

        await controller`commit`;
        await expect(consumption).resolves.toEqual({ status: "invalid" });
        const [storedToken] = await db
          .select()
          .from(magicLinkTokens)
          .where(eq(magicLinkTokens.id, id));
        expect(storedToken.consumedAt).not.toBeNull();
        await expect(db.select().from(sessions)).resolves.toHaveLength(0);
      } finally {
        await controller`rollback`.catch(() => {});
        await Promise.allSettled([consumption].filter(Boolean));
        await controller.release();
      }
    },
  );

  it(
    "rechecks the role after a concurrent admin insert wins user creation",
    { timeout: 15_000 },
    async () => {
      const email = "concurrent-admin-insert@example.com";
      const { token, id } = await insertToken({
        key: getMagicLinkKeys().current,
        email,
      });
      const controller = await raw.reserve();
      let consumption: ReturnType<typeof consumeMagicLinkToken> | undefined;
      try {
        await controller`begin`;
        const [controllerBackend] = await controller<
          { pid: number }[]
        >`select pg_backend_pid()::integer as pid`;
        await controller`
          insert into users (email, role, password_hash)
          values (${email}, 'admin', 'test-password-hash')
        `;

        consumption = consumeMagicLinkToken(token);
        await waitForBlockedQuery('insert into "users"%', controllerBackend.pid);

        await controller`commit`;
        await expect(consumption).resolves.toEqual({ status: "invalid" });
        const matchingUsers = await db.select().from(users).where(eq(users.email, email));
        expect(matchingUsers).toHaveLength(1);
        expect(matchingUsers[0].role).toBe("admin");
        const [storedToken] = await db
          .select()
          .from(magicLinkTokens)
          .where(eq(magicLinkTokens.id, id));
        expect(storedToken.consumedAt).not.toBeNull();
        await expect(db.select().from(sessions)).resolves.toHaveLength(0);
      } finally {
        await controller`rollback`.catch(() => {});
        await Promise.allSettled([consumption].filter(Boolean));
        await controller.release();
      }
    },
  );

  it("lets exactly one of two concurrent admin confirmations burn the token", async () => {
    const [admin] = await db
      .insert(users)
      .values({
        email: "admin-race@example.com",
        role: "admin",
        passwordHash: "test-password-hash",
      })
      .returning();
    const { token, id } = await insertToken({
      key: getMagicLinkKeys().current,
      email: admin.email,
    });

    const outcomes = await Promise.all([
      consumeMagicLinkToken(token),
      consumeMagicLinkToken(token),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "invalid")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "replayed")).toHaveLength(1);
    await expect(db.select().from(sessions)).resolves.toHaveLength(0);
    const events = await db.select().from(appEvents);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payloadJson)).toEqual(
      expect.arrayContaining([
        {
          reason: "invalid",
          boundary: "admin",
          tokenId: id,
          keyId: "k2",
          userId: admin.id,
        },
        { reason: "replayed", tokenId: id, keyId: "k2" },
      ]),
    );
  });

  it("lets exactly one of two concurrent confirmations win", async () => {
    const { token } = await insertToken({
      key: getMagicLinkKeys().current,
      email: "race@example.com",
    });

    const outcomes = await Promise.all([
      consumeMagicLinkToken(token),
      consumeMagicLinkToken(token),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "consumed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "replayed")).toHaveLength(1);
    const raceUsers = await db.select().from(users).where(eq(users.email, "race@example.com"));
    expect(raceUsers).toHaveLength(1);
    await expect(
      db.select().from(sessions).where(eq(sessions.userId, raceUsers[0].id)),
    ).resolves.toHaveLength(1);
  });

  it("rolls back token consumption and new-user creation when session insertion fails", async () => {
    const { token, id } = await insertToken({
      key: getMagicLinkKeys().current,
      email: "session-failure-new@example.com",
    });

    await installSessionInsertFailure();
    try {
      await expect(consumeMagicLinkToken(token, { locale: "ja" })).rejects.toMatchObject({
        cause: {
          code: "P0001",
          message: "test magic link session insert failure",
        },
      });
    } finally {
      await removeSessionInsertFailure();
    }

    const [afterFailure] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, id));
    expect(afterFailure.consumedAt).toBeNull();
    await expect(
      db.select().from(users).where(eq(users.email, "session-failure-new@example.com")),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(sessions)).resolves.toHaveLength(0);
    await expect(db.select().from(appEvents)).resolves.toHaveLength(0);

    await expect(consumeMagicLinkToken(token, { locale: "ja" })).resolves.toMatchObject({
      status: "consumed",
    });
    const createdUsers = await db
      .select()
      .from(users)
      .where(eq(users.email, "session-failure-new@example.com"));
    expect(createdUsers).toHaveLength(1);
    expect(createdUsers[0].locale).toBe("ja");
    expect(createdUsers[0].lastLoginAt).not.toBeNull();
    await expect(
      db.select().from(sessions).where(eq(sessions.userId, createdUsers[0].id)),
    ).resolves.toHaveLength(1);
    const newUserEvents = await db.select().from(appEvents);
    expect(newUserEvents.map((event) => event.type).sort()).toEqual([
      "magic_link_consumed",
      "user_login",
    ]);
  });

  it("rolls back existing-user login metadata when session insertion fails", async () => {
    const originalLastLoginAt = new Date("2025-01-02T03:04:05.000Z");
    const [member] = await db
      .insert(users)
      .values({
        email: "session-failure-existing@example.com",
        role: "member",
        locale: "en",
        lastLoginAt: originalLastLoginAt,
      })
      .returning();
    const { token, id } = await insertToken({
      key: getMagicLinkKeys().current,
      email: member.email,
    });

    await installSessionInsertFailure();
    try {
      await expect(consumeMagicLinkToken(token, { locale: "ja" })).rejects.toMatchObject({
        cause: {
          code: "P0001",
          message: "test magic link session insert failure",
        },
      });
    } finally {
      await removeSessionInsertFailure();
    }

    const [afterFailure] = await db.select().from(users).where(eq(users.id, member.id));
    expect(afterFailure.locale).toBe("en");
    expect(afterFailure.lastLoginAt).toEqual(originalLastLoginAt);
    const [tokenAfterFailure] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, id));
    expect(tokenAfterFailure.consumedAt).toBeNull();
    await expect(
      db.select().from(sessions).where(eq(sessions.userId, member.id)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(appEvents)).resolves.toHaveLength(0);

    await expect(consumeMagicLinkToken(token, { locale: "ja" })).resolves.toMatchObject({
      status: "consumed",
    });
    const [afterRetry] = await db.select().from(users).where(eq(users.id, member.id));
    expect(afterRetry.locale).toBe("ja");
    expect(afterRetry.lastLoginAt!.getTime()).toBeGreaterThan(originalLastLoginAt.getTime());
    await expect(
      db.select().from(sessions).where(eq(sessions.userId, member.id)),
    ).resolves.toHaveLength(1);
    const existingUserEvents = await db.select().from(appEvents);
    expect(existingUserEvents.map((event) => event.type).sort()).toEqual([
      "magic_link_consumed",
      "user_login",
    ]);
  });

  it(
    "lets a waiting confirmation take over after the lock holder rolls back",
    { timeout: 15_000 },
    async () => {
      const holderUserAgent = "magic-link-session-handoff-holder";
      const winnerUserAgent = "magic-link-session-handoff-winner";
      const { token, id } = await insertToken({
        key: getMagicLinkKeys().current,
        email: "handoff@example.com",
      });
      await db.execute(sql`
        alter table sessions
        add constraint olp_test_reject_handoff_holder
        check (user_agent is distinct from 'magic-link-session-handoff-holder') not valid
      `);

      const controller = await raw.reserve();
      let holderAttempt:
        | Promise<
            | { kind: "resolved"; value: Awaited<ReturnType<typeof consumeMagicLinkToken>> }
            | { kind: "rejected"; error: unknown }
          >
        | undefined;
      let waitingAttempt: ReturnType<typeof consumeMagicLinkToken> | undefined;
      try {
        await controller`begin`;
        const [controllerBackend] = await controller<
          { pid: number }[]
        >`select pg_backend_pid()::integer as pid`;
        await controller`lock table sessions in share mode`;

        holderAttempt = consumeMagicLinkToken(token, {
          locale: "en",
          ip: "198.51.100.31",
          userAgent: holderUserAgent,
        }).then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        const holderPid = await waitForBlockedQuery(
          '%insert into "sessions"%',
          controllerBackend.pid,
        );

        waitingAttempt = consumeMagicLinkToken(token, {
          locale: "ja",
          ip: "198.51.100.32",
          userAgent: winnerUserAgent,
        });
        await waitForBlockedQuery('%update "magic_link_tokens"%', holderPid);

        await controller`commit`;
        const [holderOutcome, waitingOutcome] = await Promise.all([holderAttempt, waitingAttempt]);

        expect(holderOutcome.kind).toBe("rejected");
        if (holderOutcome.kind !== "rejected") throw new Error("holder unexpectedly committed");
        expect(holderOutcome.error).toMatchObject({
          cause: {
            code: "23514",
            constraint_name: "olp_test_reject_handoff_holder",
          },
        });
        expect(waitingOutcome.status).toBe("consumed");

        const [storedToken] = await db
          .select()
          .from(magicLinkTokens)
          .where(eq(magicLinkTokens.id, id));
        expect(storedToken.consumedAt).not.toBeNull();
        const handoffUsers = await db
          .select()
          .from(users)
          .where(eq(users.email, "handoff@example.com"));
        expect(handoffUsers).toHaveLength(1);
        expect(handoffUsers[0]).toMatchObject({ locale: "ja" });
        expect(handoffUsers[0].lastLoginAt).not.toBeNull();
        const handoffSessions = await db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, handoffUsers[0].id));
        expect(handoffSessions).toHaveLength(1);
        expect(handoffSessions[0]).toMatchObject({
          ip: "198.51.100.32",
          userAgent: winnerUserAgent,
        });
        await expect(consumeMagicLinkToken(token)).resolves.toEqual({ status: "replayed" });
      } finally {
        await controller`rollback`.catch(() => {});
        await Promise.allSettled([holderAttempt, waitingAttempt].filter(Boolean));
        await controller.release();
        await removeSessionHandoffConstraint();
      }
    },
  );

  it("rejects expired tokens on both the verify and consume paths", async () => {
    const { token } = await insertToken({
      key: getMagicLinkKeys().current,
      email: "late@example.com",
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(verifyMagicLinkToken(token)).resolves.toEqual({ status: "expired" });
    await expect(consumeMagicLinkToken(token)).resolves.toEqual({ status: "expired" });
    await expect(db.select().from(users)).resolves.toHaveLength(0);
  });

  it("honors previous-key tokens during rotation and rejects retired keys", async () => {
    const keys = getMagicLinkKeys();
    const { token: previousKeyToken } = await insertToken({
      key: keys.previous!,
      email: "rotated@example.com",
    });
    await expect(consumeMagicLinkToken(previousKeyToken)).resolves.toMatchObject({
      status: "consumed",
    });

    const retired = generateMagicLinkToken({
      keyId: "k0",
      secret: "retired-secret-32-bytes-long!!!!",
    });
    await expect(verifyMagicLinkToken(retired.token)).resolves.toEqual({ status: "invalid" });
    await expect(consumeMagicLinkToken(retired.token)).resolves.toEqual({ status: "invalid" });
  });

  it("rejects a forged token even when its random part matches an existing row's input", async () => {
    const keys = getMagicLinkKeys();
    const { token } = await insertToken({ key: keys.current, email: "forge@example.com" });
    // Same random part, but re-labelled with the previous key id: the HMAC no
    // longer matches any stored (hash, keyId) pair.
    const forged = token.replace(".k2.", ".k1.");
    await expect(consumeMagicLinkToken(forged)).resolves.toEqual({ status: "invalid" });
  });

  it("returns only allowlisted redirect paths from consumption", async () => {
    const keys = getMagicLinkKeys();
    const { token } = await insertToken({
      key: keys.current,
      email: "redirect@example.com",
      redirectPath: "/posts/deep-dive",
    });
    await expect(consumeMagicLinkToken(token)).resolves.toMatchObject({
      status: "consumed",
      redirectPath: "/posts/deep-dive",
    });

    // A hostile value that somehow reached the column is still neutralized on read.
    const { token: hostileToken } = await insertToken({
      key: keys.current,
      email: "redirect2@example.com",
      redirectPath: "//evil.example/phish",
    });
    await expect(consumeMagicLinkToken(hostileToken)).resolves.toMatchObject({
      status: "consumed",
      redirectPath: null,
    });
  });

  it("does not mint links or tasks when suppressed by an in-flight delivery", async () => {
    await requestMagicLink("busy@example.com", { identity, ip: identity.value });
    await expect(
      requestMagicLink("busy@example.com", { identity, ip: identity.value }),
    ).resolves.toEqual({ suppressed: true });
    await expect(db.select().from(tasks)).resolves.toHaveLength(1);
  });
});
