import { and, eq, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { notificationPreferences } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { verifyNotificationUnsubscribeToken } from "@/modules/notifications/unsubscribe-token";

export type NotificationPreferenceView = {
  newPostEmailEnabled: boolean;
  version: number;
};

export type NotificationUnsubscribeResult = "success" | "already-disabled" | "invalid";

export async function getNotificationPreference(
  userId: string,
  db: DbClient = getDb(),
): Promise<NotificationPreferenceView> {
  const [preference] = await db
    .select({
      newPostEmailEnabled: notificationPreferences.newPostEmailEnabled,
      version: notificationPreferences.version,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);
  return preference ?? { newPostEmailEnabled: false, version: 0 };
}

export async function setNotificationPreference(input: {
  userId: string;
  newPostEmailEnabled: boolean;
}): Promise<NotificationPreferenceView> {
  const [preference] = await getDb().execute<NotificationPreferenceView>(sql`
    INSERT INTO notification_preferences (user_id, new_post_email_enabled, version, updated_at)
    VALUES (${input.userId}, ${input.newPostEmailEnabled}, 1, now())
    ON CONFLICT (user_id) DO UPDATE
      SET new_post_email_enabled = excluded.new_post_email_enabled,
          version = notification_preferences.version + 1,
          updated_at = now()
    RETURNING
      new_post_email_enabled AS "newPostEmailEnabled",
      version
  `);
  if (!preference) throw new ApiError(500, "internalError");
  return preference;
}

export async function unsubscribeNotificationToken(
  token: string,
): Promise<NotificationUnsubscribeResult> {
  const verification = await verifyNotificationUnsubscribeToken(token);
  if (!verification.valid) {
    return verification.reason === "preference-disabled" ? "already-disabled" : "invalid";
  }

  const payload = verification.payload;
  const [updated] = await getDb()
    .update(notificationPreferences)
    .set({
      newPostEmailEnabled: false,
      version: sql`${notificationPreferences.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(notificationPreferences.userId, payload.userId),
        eq(notificationPreferences.version, payload.preferenceVersion),
        eq(notificationPreferences.newPostEmailEnabled, true),
      ),
    )
    .returning({ id: notificationPreferences.id });

  return updated ? "success" : "already-disabled";
}
