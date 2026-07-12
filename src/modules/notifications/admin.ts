import { desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { notificationCampaigns, posts } from "@/db/schema";

export type NotificationCampaignAdminSummary = {
  id: string;
  postId: string;
  postTitle: string | null;
  postSlug: string | null;
  source: "manual_publish" | "scheduled_publish";
  status: "pending" | "expanding" | "expanded" | "sending" | "completed" | "dead";
  publishedAt: Date;
  cursorUserId: string | null;
  expansionCompletedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
  deliveryCounts: Record<string, number>;
  attemptCounts: Record<string, number>;
  suppressionCount: number;
};

function countRows(rows: { key: string | null; count: number | string }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key ?? "unknown", Number(row.count)]));
}

async function hydrateCampaignSummary(campaignId: string) {
  const [campaign] = await getDb()
    .select({
      id: notificationCampaigns.id,
      postId: notificationCampaigns.postId,
      postTitle: posts.title,
      postSlug: posts.slug,
      source: notificationCampaigns.source,
      status: notificationCampaigns.status,
      publishedAt: notificationCampaigns.publishedAt,
      cursorUserId: notificationCampaigns.cursorUserId,
      expansionCompletedAt: notificationCampaigns.expansionCompletedAt,
      completedAt: notificationCampaigns.completedAt,
      createdAt: notificationCampaigns.createdAt,
      updatedAt: notificationCampaigns.updatedAt,
      lastError: notificationCampaigns.lastError,
    })
    .from(notificationCampaigns)
    .leftJoin(posts, eq(posts.id, notificationCampaigns.postId))
    .where(eq(notificationCampaigns.id, campaignId))
    .limit(1);
  if (!campaign) return null;

  const [deliveryRows, attemptRows, suppressionRows] = await Promise.all([
    getDb().execute<{ key: string; count: number | string }>(sql`
      SELECT status AS key, count(*)::int AS count
      FROM notification_deliveries
      WHERE campaign_id = ${campaignId}
      GROUP BY status
    `),
    getDb().execute<{ key: string; count: number | string }>(sql`
      SELECT outcome AS key, count(*)::int AS count
      FROM notification_delivery_attempts
      WHERE campaign_id = ${campaignId}
      GROUP BY outcome
    `),
    getDb().execute<{ count: number | string }>(sql`
      SELECT count(*)::int AS count
      FROM notification_suppressions
      WHERE first_delivery_id IN (
        SELECT id FROM notification_deliveries WHERE campaign_id = ${campaignId}
      )
         OR last_delivery_id IN (
        SELECT id FROM notification_deliveries WHERE campaign_id = ${campaignId}
      )
    `),
  ]);

  return {
    ...campaign,
    deliveryCounts: countRows(deliveryRows),
    attemptCounts: countRows(attemptRows),
    suppressionCount: Number(suppressionRows[0]?.count ?? 0),
  } satisfies NotificationCampaignAdminSummary;
}

export async function listNotificationCampaignAdminSummaries(): Promise<
  NotificationCampaignAdminSummary[]
> {
  const campaigns = await getDb()
    .select({ id: notificationCampaigns.id })
    .from(notificationCampaigns)
    .orderBy(desc(notificationCampaigns.createdAt), desc(notificationCampaigns.id))
    .limit(50);

  const summaries = await Promise.all(
    campaigns.map((campaign) => hydrateCampaignSummary(campaign.id)),
  );
  return summaries.filter((summary) => summary !== null);
}

export async function getNotificationCampaignAdminSummary(
  campaignId: string,
): Promise<NotificationCampaignAdminSummary | null> {
  return hydrateCampaignSummary(campaignId);
}
