import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  magicLinkDeliveryDispositions,
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

function runRollback(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/magic-link-rollback.mjs", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: getEnv().DATABASE_URL,
        MAGIC_LINK_PENDING_CLEANUP_MIN_AGE_MINUTES: "30",
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

describeWithDatabase("Magic Link rollback disposition bundle", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function seedTerminalPending(input: {
    reservationId?: string | null;
    createdAt?: Date;
    taskPayloadTokenId?: string;
  }) {
    const [request] = await db
      .insert(magicLinkRequests)
      .values({ email: `rollback-${randomUUID()}@example.test` })
      .returning();
    const [candidate] = await db
      .insert(magicLinkTokens)
      .values({
        email: request.email,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(0),
        deliveryState: "pending",
        deliveredAt: null,
        deliveryReservationId: input.reservationId ?? null,
        deliveryReservationUntil: input.reservationId ? new Date(Date.now() - 60_000) : null,
        createdAt: input.createdAt ?? new Date(Date.now() - 31 * 60_000),
      })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({
        kind: "auth.magic_link_email",
        dedupeKey: `rollback-${candidate.id}`,
        payloadJson: {
          version: 1,
          deliveryProtocol: 2,
          tokenId: input.taskPayloadTokenId ?? candidate.id,
          encryptedToken: "test-encrypted-token",
        },
        queueClass: "auth_delivery_v2",
        status: "dead",
      })
      .returning();
    const mintedAt = new Date();
    await db
      .update(magicLinkRequests)
      .set({ resolvedAt: mintedAt, mintedAt, mintedTokenId: candidate.id })
      .where(eq(magicLinkRequests.id, request.id));
    await db.insert(magicLinkMintLedger).values({
      requestId: request.id,
      mintedTokenId: candidate.id,
      deliveryTaskId: task.id,
      mintedAt,
    });
    return { candidate, task };
  }

  it("cleans only aged terminal candidates with NULL reservations and verifies the scope reaches zero", async () => {
    const seeded = await seedTerminalPending({});

    await expect(runRollback(["count", "--scope", "aged-null"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('"count":1'),
    });
    await expect(runRollback(["cleanup-aged-null", "--confirm"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('"cleaned":1'),
    });
    await expect(runRollback(["verify-zero", "--scope", "aged-null"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('"count":0'),
    });

    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, seeded.candidate.id));
    const [disposition] = await db
      .select()
      .from(magicLinkDeliveryDispositions)
      .where(eq(magicLinkDeliveryDispositions.candidateId, seeded.candidate.id));
    expect(candidate).toMatchObject({ deliveryState: "cancelled" });
    expect(disposition).toMatchObject({ finalState: "cancelled", reservationId: null });
  });

  it("lists every runnable Phase-A legacy delivery residue and blocks Phase B until it is zero", async () => {
    const [residue] = await db
      .insert(tasks)
      .values({
        kind: "auth.magic_link_email",
        dedupeKey: `legacy-phase-a-${randomUUID()}`,
        payloadJson: {
          version: 1,
          tokenId: randomUUID(),
          encryptedToken: "must-not-appear-in-operator-output",
        },
        queueClass: "transactional",
        status: "failed",
      })
      .returning();

    await expect(
      runRollback(["count", "--scope", "legacy-delivery-residue"]),
    ).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('"count":1'),
    });
    await expect(runRollback(["list-legacy-residue"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining(residue!.id),
    });
    const listed = await runRollback(["list-legacy-residue"]);
    expect(listed.stdout).not.toContain("must-not-appear-in-operator-output");
    await expect(
      runRollback(["verify-zero", "--scope", "legacy-delivery-residue"]),
    ).resolves.toMatchObject({
      code: 3,
      stdout: expect.stringContaining('"count":1'),
    });
  });

  it("quarantines a stopped Phase-A processing task without SMTP and neutralizes its active token", async () => {
    const [candidate] = await db
      .insert(magicLinkTokens)
      .values({
        email: `legacy-quarantine-${randomUUID()}@example.test`,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        deliveryState: "active",
        deliveredAt: new Date(),
      })
      .returning();
    const [legacyTask] = await db
      .insert(tasks)
      .values({
        kind: "auth.magic_link_email",
        dedupeKey: `auth-magic-link-email:${candidate!.id}`,
        payloadJson: {
          version: 1,
          tokenId: candidate!.id,
          encryptedToken: "legacy-encrypted-token",
        },
        queueClass: "transactional",
        status: "processing",
        lockedAt: new Date(Date.now() - 60_000),
        lockedBy: "phase-a-worker-that-was-stopped",
        leaseUntil: new Date(0),
      })
      .returning();

    await expect(runRollback(["quarantine-legacy-residue", "--confirm"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('"terminalized":1'),
    });
    await expect(
      runRollback(["verify-zero", "--scope", "legacy-delivery-residue"]),
    ).resolves.toMatchObject({ code: 0, stdout: expect.stringContaining('"count":0') });

    const [storedCandidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, candidate!.id));
    const [storedTask] = await db.select().from(tasks).where(eq(tasks.id, legacyTask!.id));
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, candidate!.id),
          eq(auditEvents.action, "magic_link_legacy_delivery_quarantined"),
        ),
      );
    expect(storedCandidate).toMatchObject({ deliveryState: "cancelled" });
    expect(storedCandidate!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(storedTask).toMatchObject({ status: "succeeded", lockedBy: null });
    expect(audit?.afterJson).toMatchObject({
      taskId: legacyTask!.id,
      outcome: "token_neutralized",
      phase: "protocol_v2_cutover",
    });
  });

  it("terminalizes a corrupted legacy dedupe graph without touching its payload token", async () => {
    const [target] = await db
      .insert(magicLinkTokens)
      .values({
        email: `legacy-target-${randomUUID()}@example.test`,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        deliveryState: "active",
        deliveredAt: new Date(),
      })
      .returning();
    const [unrelated] = await db
      .insert(magicLinkTokens)
      .values({
        email: `legacy-unrelated-${randomUUID()}@example.test`,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        deliveryState: "active",
        deliveredAt: new Date(),
      })
      .returning();
    const [corruptTask] = await db
      .insert(tasks)
      .values({
        kind: "auth.magic_link_email",
        dedupeKey: `auth-magic-link-email:${unrelated!.id}`,
        payloadJson: {
          version: 1,
          tokenId: target!.id,
          encryptedToken: "legacy-encrypted-token",
        },
        queueClass: "transactional",
        status: "failed",
      })
      .returning();

    await expect(runRollback(["quarantine-legacy-residue", "--confirm"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('"terminalized":1'),
    });

    const [storedTarget] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, target!.id));
    const [storedTask] = await db.select().from(tasks).where(eq(tasks.id, corruptTask!.id));
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, corruptTask!.id),
          eq(auditEvents.action, "magic_link_legacy_delivery_quarantined_invalid"),
        ),
      );
    expect(storedTarget).toMatchObject({ deliveryState: "active" });
    expect(storedTarget!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(storedTask).toMatchObject({ status: "dead", lockedBy: null });
    expect(audit?.afterJson).toMatchObject({
      taskId: corruptTask!.id,
      outcome: "invalid_graph_terminalized",
    });
  });

  it("requires an explicit full-quiescence attestation before abandoning a non-null fence", async () => {
    const reservationId = randomUUID();
    const seeded = await seedTerminalPending({ reservationId });
    const [actor] = await db
      .insert(users)
      .values({ email: `operator-${randomUUID()}@example.test`, role: "admin" })
      .returning();

    await expect(
      runRollback([
        "abandon",
        "--candidate-id",
        seeded.candidate.id,
        "--reservation-id",
        reservationId,
        "--actor-id",
        actor.id,
        "--reason",
        "approved recovery",
      ]),
    ).resolves.toMatchObject({ code: 1, stderr: expect.stringContaining("full-quiescence") });

    await expect(
      runRollback([
        "abandon",
        "--candidate-id",
        seeded.candidate.id,
        "--reservation-id",
        reservationId,
        "--actor-id",
        actor.id,
        "--reason",
        "approved recovery",
        "--quiescence-attestation",
        "all app and dispatcher instances stopped; no SMTP invocation can resume",
        "--stopped-instance-ids",
        "web-1,dispatcher-1,admin-job-1,ops-bundle-1",
        "--full-quiescence",
        "--confirm",
      ]),
    ).resolves.toMatchObject({ code: 0, stdout: expect.stringContaining('"status":"abandoned"') });

    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, seeded.candidate.id));
    const [disposition] = await db
      .select()
      .from(magicLinkDeliveryDispositions)
      .where(eq(magicLinkDeliveryDispositions.candidateId, seeded.candidate.id));
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, seeded.candidate.id),
          eq(auditEvents.action, "magic_link_reservation_abandoned"),
        ),
      );
    expect(candidate).toMatchObject({ deliveryState: "cancelled", deliveryReservationId: null });
    expect(disposition).toMatchObject({
      finalState: "abandoned",
      reservationId,
    });
    expect(audit?.afterJson).toMatchObject({ fullQuiescenceAttested: true });
  });

  it("fails closed when cleanup or abandon sees a v2 task for another candidate", async () => {
    const cleanup = await seedTerminalPending({ taskPayloadTokenId: randomUUID() });
    const reservationId = randomUUID();
    const abandoned = await seedTerminalPending({
      reservationId,
      taskPayloadTokenId: randomUUID(),
    });
    const [actor] = await db
      .insert(users)
      .values({ email: `operator-${randomUUID()}@example.test`, role: "admin" })
      .returning();

    await expect(runRollback(["cleanup-aged-null", "--confirm"])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('"cleaned":0'),
    });
    await expect(
      db.select().from(magicLinkTokens).where(eq(magicLinkTokens.id, cleanup.candidate.id)),
    ).resolves.toMatchObject([{ deliveryState: "pending" }]);

    await expect(
      runRollback([
        "abandon",
        "--candidate-id",
        abandoned.candidate.id,
        "--reservation-id",
        reservationId,
        "--actor-id",
        actor!.id,
        "--reason",
        "refuse mismatched task graph",
        "--quiescence-attestation",
        "all app and dispatcher instances stopped; no SMTP invocation can resume",
        "--stopped-instance-ids",
        "web-1,dispatcher-1,admin-job-1,ops-bundle-1",
        "--full-quiescence",
        "--confirm",
      ]),
    ).resolves.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("protocol-v2 delivery task linked to candidate"),
    });
    await expect(
      db.select().from(magicLinkTokens).where(eq(magicLinkTokens.id, abandoned.candidate.id)),
    ).resolves.toMatchObject([{ deliveryState: "pending", deliveryReservationId: reservationId }]);
  });

  it("expires non-active candidates without changing their lifecycle or touching active tokens", async () => {
    const [actor] = await db
      .insert(users)
      .values({ email: `operator-${randomUUID()}@example.test`, role: "admin" })
      .returning();
    const [nonActive] = await db
      .insert(magicLinkTokens)
      .values({
        email: `neutralize-${randomUUID()}@example.test`,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        deliveryState: "superseded",
        supersededAt: new Date(),
      })
      .returning();
    const [active] = await db
      .insert(magicLinkTokens)
      .values({
        email: `active-${randomUUID()}@example.test`,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      .returning();

    await expect(
      runRollback([
        "neutralize-non-active",
        "--actor-id",
        actor.id,
        "--reason",
        "legacy image rollback",
        "--rollback-attestation",
        "intake drained before legacy image admission",
        "--confirm",
      ]),
    ).resolves.toMatchObject({ code: 0, stdout: expect.stringContaining('"neutralized":1') });
    await expect(
      runRollback(["verify-zero", "--scope", "non-active-unexpired"]),
    ).resolves.toMatchObject({ code: 0 });

    const [storedNonActive] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, nonActive.id));
    const [storedActive] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, active.id));
    expect(storedNonActive).toMatchObject({ deliveryState: "superseded" });
    expect(storedNonActive!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(storedActive).toMatchObject({ deliveryState: "active" });
    expect(storedActive!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
