import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  appEvents,
  auditEvents,
  magicLinkMintLedger,
  magicLinkRequests,
  magicLinkTokens,
  tasks,
  users,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

function runAdminReset(
  input: { email: string; password: string },
  scriptPath = "scripts/admin-reset.mjs",
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: getEnv().DATABASE_URL,
        ADMIN_EMAIL: input.email,
        ADMIN_PASSWORD: input.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    void once(child, "close").then(([code]) => resolve({ code, stdout, stderr }));
  });
}

async function attachV2MintLedger(input: { candidateId: string; email: string }) {
  const mintedAt = new Date();
  const [request] = await getDb()
    .insert(magicLinkRequests)
    .values({
      email: input.email,
      resolvedAt: mintedAt,
      mintedAt,
      mintedTokenId: input.candidateId,
    })
    .returning();
  const [task] = await getDb()
    .insert(tasks)
    .values({
      kind: "auth.magic_link_email",
      dedupeKey: `admin-reset-fixture:${input.candidateId}`,
      payloadJson: {
        version: 1,
        deliveryProtocol: 2,
        tokenId: input.candidateId,
        encryptedToken: "fixture-encrypted-token",
      },
      queueClass: "auth_delivery_v2",
      status: "pending",
    })
    .returning();
  await getDb().insert(magicLinkMintLedger).values({
    requestId: request!.id,
    mintedTokenId: input.candidateId,
    deliveryTaskId: task!.id,
    mintedAt,
  });
}

describeWithDatabase("admin-reset Magic Link fence", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("exits with a safe retryable block instead of promoting through an in-flight SMTP reservation", async () => {
    const email = `recovery-${randomUUID()}@example.test`;
    const reservationId = randomUUID();
    await db.insert(magicLinkTokens).values({
      email,
      tokenHash: randomUUID().replaceAll("-", ""),
      keyId: "test",
      expiresAt: new Date(0),
      deliveryState: "pending",
      deliveredAt: null,
      deliveryReservationId: reservationId,
      deliveryReservationUntil: new Date(Date.now() - 60_000),
    });

    const outcome = await runAdminReset({ email, password: "correct horse battery staple" });

    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toMatch(/safely blocked/i);
    const recovered = await db.select().from(users).where(eq(users.email, email));
    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, email));
    const events = await db
      .select()
      .from(appEvents)
      .where(eq(appEvents.type, "magic_link_promotion_blocked"));
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, candidate.id),
          eq(auditEvents.action, "magic_link_promotion_blocked"),
        ),
      );
    expect(recovered).toHaveLength(0);
    expect(candidate).toMatchObject({
      deliveryState: "pending",
      deliveryReservationId: reservationId,
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.payloadJson)).not.toContain(email);
    expect(JSON.stringify(audit?.afterJson)).not.toContain(email);
  });

  it("cancels only unreserved pending candidates before the audited promotion", async () => {
    const email = `recovery-${randomUUID()}@example.test`;
    const [candidate] = await db
      .insert(magicLinkTokens)
      .values({
        email,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(0),
        deliveryState: "pending",
        deliveredAt: null,
      })
      .returning();
    await attachV2MintLedger({ candidateId: candidate!.id, email });

    const outcome = await runAdminReset({ email, password: "correct horse battery staple" });

    expect(outcome.code).toBe(0);
    const [recovered] = await db.select().from(users).where(eq(users.email, email));
    const [cancelled] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, candidate.id));
    expect(recovered).toMatchObject({ email, role: "admin" });
    expect(cancelled).toMatchObject({ deliveryState: "cancelled" });
  });

  it("fails closed when an unreserved v2 pending candidate has no immutable mint ledger", async () => {
    const email = `corrupt-recovery-${randomUUID()}@example.test`;
    const [candidate] = await db
      .insert(magicLinkTokens)
      .values({
        email,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(0),
        deliveryState: "pending",
        deliveredAt: null,
      })
      .returning();

    const outcome = await runAdminReset({ email, password: "correct horse battery staple" });

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/immutable mint ledger/i);
    await expect(db.select().from(users).where(eq(users.email, email))).resolves.toHaveLength(0);
    const [unchanged] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, candidate!.id));
    expect(unchanged).toMatchObject({ deliveryState: "pending" });
  });

  it("keeps an exact-base legacy admin-reset artifact as the mixed-version risk fixture", async () => {
    const email = `legacy-recovery-${randomUUID()}@example.test`;
    const reservationId = randomUUID();
    await db.insert(magicLinkTokens).values({
      email,
      tokenHash: randomUUID().replaceAll("-", ""),
      keyId: "test",
      expiresAt: new Date(0),
      deliveryState: "pending",
      deliveredAt: null,
      deliveryReservationId: reservationId,
      deliveryReservationUntil: new Date(Date.now() - 60_000),
    });

    const outcome = await runAdminReset(
      { email, password: "correct horse battery staple" },
      "scripts/fixtures/admin-reset-exact-base-80dbaa.mjs",
    );

    // The fixture is the source artifact from 80dbaa. It demonstrates why
    // only the Phase-A inventory can authorize enabling v2: that bundle has
    // no reservation check and would promote through this fence.
    expect(outcome.code).toBe(0);
    const [legacyPromotion] = await db.select().from(users).where(eq(users.email, email));
    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, email));
    expect(legacyPromotion).toMatchObject({ role: "admin" });
    expect(candidate).toMatchObject({
      deliveryState: "pending",
      deliveryReservationId: reservationId,
    });
  });
});
