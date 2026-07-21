import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmtpConfig: vi.fn(),
  sendMagicLinkEmail: vi.fn(),
}));

vi.mock("@/modules/config", () => ({
  getSmtpConfig: mocks.getSmtpConfig,
}));
vi.mock("@/modules/mail", () => ({
  sendMagicLinkEmail: mocks.sendMagicLinkEmail,
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
import { magicLinkTokens, tasks, users } from "@/db/schema";
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

describeWithDatabase("WP1 magic link integration", () => {
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
    mocks.sendMagicLinkEmail.mockResolvedValue(undefined);
    await resetDatabase(db);
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

    const consumption = await consumeMagicLinkToken(token, { locale: "ja" });
    expect(consumption.status).toBe("consumed");
    if (consumption.status !== "consumed") throw new Error("unreachable");
    expect(consumption.user.email).toBe("fan@example.com");
    expect(consumption.redirectPath).toBeNull();

    const [member] = await db.select().from(users).where(eq(users.email, "fan@example.com"));
    expect(member.role).toBe("member");

    // Replay after consumption fails closed, and the row stays consumed once.
    await expect(consumeMagicLinkToken(token)).resolves.toEqual({ status: "replayed" });
    await expect(verifyMagicLinkToken(token)).resolves.toEqual({ status: "replayed" });
  });

  it("silently declines to mint links for admin mailboxes", async () => {
    await db.insert(users).values({ email: "boss@example.com", role: "admin" });

    // Same accepted-shaped suppression as the dedupe path: no enumeration signal.
    await expect(
      requestMagicLink("Boss@Example.com", { identity, ip: identity.value }),
    ).resolves.toEqual({ suppressed: true });
    await expect(db.select().from(magicLinkTokens)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("fails closed when a minted token's mailbox belongs to an admin", async () => {
    await db.insert(users).values({ email: "boss@example.com", role: "admin" });
    const { token } = await insertToken({
      key: getMagicLinkKeys().current,
      email: "boss@example.com",
    });

    await expect(consumeMagicLinkToken(token)).resolves.toEqual({ status: "invalid" });

    // The token is burned by the failed confirmation and cannot be replayed.
    const [row] = await db.select().from(magicLinkTokens);
    expect(row.consumedAt).not.toBeNull();
    await expect(consumeMagicLinkToken(token)).resolves.toEqual({ status: "replayed" });

    // The admin row is untouched: no role change, no fan account minted.
    const adminRows = await db.select().from(users).where(eq(users.email, "boss@example.com"));
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0].role).toBe("admin");
    expect(adminRows[0].lastLoginAt).toBeNull();
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
    await expect(
      db.select().from(users).where(eq(users.email, "race@example.com")),
    ).resolves.toHaveLength(1);
  });

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
