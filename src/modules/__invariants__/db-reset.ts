import { sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";

/**
 * Clear integration-test state without maintaining a fragile foreign-key deletion order.
 * Keep this list aligned with the application tables exported from the current schema.
 */
export async function resetDatabase(db: DbClient = getDb()): Promise<void> {
  await db.execute(sql`
    truncate table
      notification_delivery_attempts,
      notification_quota_windows,
      notification_suppressions,
      notification_deliveries,
      notification_campaigns,
      notification_preferences,
      audit_events,
      tasks,
      app_events,
      payment_provider_events,
      payment_proof_upload_reservations,
      download_logs,
      post_tags,
      post_categories,
      post_files,
      post_translations,
      payment_requests,
      subscriptions,
      supporter_wall_entries,
      memberships,
      posts,
      files,
      tags,
      categories,
      membership_tiers,
      payment_methods,
      sessions,
      login_codes,
      magic_link_tokens,
      oauth_identities,
      oauth_states,
      users,
      site_settings,
      app_settings
    restart identity cascade
  `);
}
