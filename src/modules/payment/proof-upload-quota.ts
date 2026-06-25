import { and, eq, gt, or, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { paymentProofUploadReservations } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";

export async function reservePaymentProofUpload(userId: string): Promise<string> {
  const env = getEnv();
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`proof-upload-quota:${userId}`}, 0))`,
    );

    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentProofUploadReservations)
      .where(
        and(
          eq(paymentProofUploadReservations.userId, userId),
          or(
            and(
              eq(paymentProofUploadReservations.status, "succeeded"),
              gt(paymentProofUploadReservations.createdAt, sql`now() - interval '24 hours'`),
            ),
            and(
              eq(paymentProofUploadReservations.status, "pending"),
              gt(paymentProofUploadReservations.expiresAt, sql`now()`),
            ),
          ),
        ),
      );
    if (Number(row?.count ?? 0) >= env.PAYMENT_PROOF_MAX_PER_DAY) {
      throw new ApiError(429, "uploadQuotaExceeded");
    }

    const [reservation] = await tx
      .insert(paymentProofUploadReservations)
      .values({
        userId,
        status: "pending",
        expiresAt: sql`now() + (${env.PROOF_UPLOAD_RESERVATION_TTL_MINUTES} * interval '1 minute')`,
      })
      .returning({ id: paymentProofUploadReservations.id });
    return reservation.id;
  });
}

export async function completePaymentProofUploadReservation(
  reservationId: string,
  succeeded: boolean,
  db: DbClient = getDb(),
): Promise<void> {
  const [updated] = await db
    .update(paymentProofUploadReservations)
    .set({ status: succeeded ? "succeeded" : "failed" })
    .where(
      and(
        eq(paymentProofUploadReservations.id, reservationId),
        eq(paymentProofUploadReservations.status, "pending"),
      ),
    )
    .returning({ id: paymentProofUploadReservations.id });
  if (!updated) {
    throw new Error("Payment proof upload reservation is not pending");
  }
}
