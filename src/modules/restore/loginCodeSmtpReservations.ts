import { isNotNull } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { loginCodes } from "@/db/schema";

/** A restored reservation needs operator evidence of SMTP socket closure before startup. */
export async function hasOutstandingLoginCodeSmtpReservations(
  db: DbClient = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: loginCodes.id })
    .from(loginCodes)
    .where(isNotNull(loginCodes.smtpReservationToken))
    .limit(1);

  return rows.length !== 0;
}
