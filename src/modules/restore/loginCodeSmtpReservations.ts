import { isNotNull, sql } from "drizzle-orm";

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

/** Catch still-connected owners outside the Compose app service before startup. */
export async function hasOtherRestoreDatabaseClients(db: DbClient = getDb()): Promise<boolean> {
  const rows = await db.execute<{ other_clients: boolean }>(sql`
    select exists (
      select 1 from pg_stat_activity
      where datname = current_database()
        and backend_type = 'client backend'
        and pid <> pg_backend_pid()
    ) as other_clients
  `);

  return rows[0]?.other_clients === true;
}
