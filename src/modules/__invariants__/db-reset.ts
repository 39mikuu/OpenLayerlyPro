import { sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";

/**
 * Clear integration-test state without maintaining a fragile foreign-key deletion order.
 * Keep this list aligned with the application tables exported from the current schema.
 */
export async function resetDatabase(db: DbClient = getDb()): Promise<void> {
  await db.execute(sql`
    truncate table
      audit_events,
      tasks,
      app_events,
      payment_provider_events,
      download_logs,
      post_tags,
      post_categories,
      post_files,
      post_translations,
      payment_requests,
      subscriptions,
      memberships,
      posts,
      files,
      tags,
      categories,
      membership_tiers,
      payment_methods,
      sessions,
      login_codes,
      users,
      site_settings,
      app_settings
    restart identity cascade
  `);
}
