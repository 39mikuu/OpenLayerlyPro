import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import {
  magicLinkDeliveryDispositions,
  magicLinkMintLedger,
  magicLinkStuckFenceAlerts,
  magicLinkTokens,
} from "@/db/schema";

export type MagicLinkDispositionState = "cancelled" | "superseded" | "abandoned";

/**
 * Write the immutable terminal disposition for a v2 candidate. The caller
 * MUST already hold the candidate row lock. Repeating the same finalization is
 * harmless; attempting a contradictory one is a corruption signal.
 */
export async function recordMagicLinkDisposition(
  tx: DbClient,
  input: {
    candidateId: string;
    finalState: MagicLinkDispositionState;
    reservationId: string | null;
  },
): Promise<void> {
  const [ledger] = await tx
    .select()
    .from(magicLinkMintLedger)
    .where(eq(magicLinkMintLedger.mintedTokenId, input.candidateId))
    .limit(1);
  if (!ledger) {
    throw new Error("Magic Link candidate is missing its immutable mint ledger");
  }

  const [inserted] = await tx
    .insert(magicLinkDeliveryDispositions)
    .values({
      candidateId: input.candidateId,
      requestId: ledger.requestId,
      mintedTokenId: ledger.mintedTokenId,
      deliveryTaskId: ledger.deliveryTaskId,
      finalState: input.finalState,
      reservationId: input.reservationId,
    })
    .onConflictDoNothing()
    .returning({
      finalState: magicLinkDeliveryDispositions.finalState,
      reservationId: magicLinkDeliveryDispositions.reservationId,
    });
  if (inserted) return;

  const [existing] = await tx
    .select({
      finalState: magicLinkDeliveryDispositions.finalState,
      reservationId: magicLinkDeliveryDispositions.reservationId,
    })
    .from(magicLinkDeliveryDispositions)
    .where(eq(magicLinkDeliveryDispositions.candidateId, input.candidateId))
    .limit(1)
    .for("update");
  if (existing?.finalState === input.finalState && existing.reservationId === input.reservationId) {
    return;
  }
  throw new Error("Magic Link candidate has a conflicting disposition record");
}

export async function recordMagicLinkDispositionIfV2(
  tx: DbClient,
  input: {
    candidateId: string;
    finalState: MagicLinkDispositionState;
    reservationId: string | null;
  },
): Promise<void> {
  const [ledger] = await tx
    .select({ requestId: magicLinkMintLedger.requestId })
    .from(magicLinkMintLedger)
    .where(eq(magicLinkMintLedger.mintedTokenId, input.candidateId))
    .limit(1);
  if (ledger) await recordMagicLinkDisposition(tx, input);
}

export async function clearMagicLinkStuckFenceAlert(
  tx: DbClient,
  input: { candidateId: string; reservationId?: string | null },
): Promise<void> {
  await tx
    .delete(magicLinkStuckFenceAlerts)
    .where(
      input.reservationId
        ? and(
            eq(magicLinkStuckFenceAlerts.candidateId, input.candidateId),
            eq(magicLinkStuckFenceAlerts.reservationId, input.reservationId),
          )
        : eq(magicLinkStuckFenceAlerts.candidateId, input.candidateId),
    );
}

export type MagicLinkPromotionFenceResult =
  | { blocked: true; reservedCandidateCount: number; reservedCandidateIds: string[] }
  | { blocked: false; cancelledCandidateIds: string[] };

/**
 * Serialize an administrator promotion with Magic Link delivery. Lock order
 * is email advisory lock(s), then candidate row(s). Any non-null reservation
 * is a safety fence regardless of its observation lease timestamp; this
 * function MUST NOT clear it or let the promotion continue.
 */
export async function enforceMagicLinkPromotionFence(
  tx: DbClient,
  emails: readonly string[],
): Promise<MagicLinkPromotionFenceResult> {
  const normalizedEmails = [...new Set(emails)].sort();
  if (normalizedEmails.length === 0) return { blocked: false, cancelledCandidateIds: [] };

  for (const email of normalizedEmails) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${email}))`);
  }

  const pending = await tx
    .select({
      id: magicLinkTokens.id,
      deliveryReservationId: magicLinkTokens.deliveryReservationId,
      deliveryReservationUntil: magicLinkTokens.deliveryReservationUntil,
    })
    .from(magicLinkTokens)
    .where(
      and(
        inArray(magicLinkTokens.email, normalizedEmails),
        eq(magicLinkTokens.deliveryState, "pending"),
      ),
    )
    .for("update");

  const reserved = pending.filter(
    (candidate) =>
      candidate.deliveryReservationId !== null || candidate.deliveryReservationUntil !== null,
  );
  if (reserved.length > 0) {
    return {
      blocked: true,
      reservedCandidateCount: reserved.length,
      reservedCandidateIds: reserved.map((candidate) => candidate.id),
    };
  }

  const candidateIds = pending.map((candidate) => candidate.id);
  if (candidateIds.length === 0) return { blocked: false, cancelledCandidateIds: [] };

  const cancelled = await tx
    .update(magicLinkTokens)
    .set({
      deliveryState: "cancelled",
      expiresAt: sql`now()`,
      deliveryReservationId: null,
      deliveryReservationUntil: null,
    })
    .where(
      and(
        inArray(magicLinkTokens.id, candidateIds),
        eq(magicLinkTokens.deliveryState, "pending"),
        isNull(magicLinkTokens.deliveryReservationId),
        isNull(magicLinkTokens.deliveryReservationUntil),
      ),
    )
    .returning({ id: magicLinkTokens.id });
  if (cancelled.length !== candidateIds.length) {
    throw new Error("Magic Link promotion fence lost a locked pending candidate");
  }
  for (const candidate of cancelled) {
    // Every pending candidate is protocol v2 and therefore MUST have its
    // immutable request/task ledger. A missing ledger is corruption, not a
    // reason to promote through a partially audited delivery state.
    await recordMagicLinkDisposition(tx, {
      candidateId: candidate.id,
      finalState: "cancelled",
      reservationId: null,
    });
    await clearMagicLinkStuckFenceAlert(tx, { candidateId: candidate.id });
  }
  return { blocked: false, cancelledCandidateIds: candidateIds };
}
