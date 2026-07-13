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

type CampaignSummaryBase = Omit<
  NotificationCampaignAdminSummary,
  "deliveryCounts" | "attemptCounts" | "suppressionCount"
>;

function countRows(rows: { key: string | null; count: number | string }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key ?? "unknown", Number(row.count)]));
}

function groupedCountMap(
  rows: { campaignId: string; key: string | null; count: number | string }[],
): Map<string, Record<string, number>> {
  const grouped = new Map<string, { key: string | null; count: number | string }[]>();
  for (const row of rows) {
    const values = grouped.get(row.campaignId) ?? [];
    values.push(row);
    grouped.set(row.campaignId, values);
  }
  return new Map([...grouped].map(([campaignId, values]) => [campaignId, countRows(values)]));
}

function numericCountMap(
  rows: { campaignId: string; count: number | string }[],
): Map<string, number> {
  return new Map(rows.map((row) => [row.campaignId, Number(row.count)]));
}

function uuidArray(ids: string[]) {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
}

function campaignBaseQuery() {
  return getDb()
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
    .leftJoin(posts, eq(posts.id, notificationCampaigns.postId));
}

async function hydrateCampaignSummaries(
  campaigns: CampaignSummaryBase[],
): Promise<NotificationCampaignAdminSummary[]> {
  if (campaigns.length === 0) return [];
  const campaignIds = campaigns.map((campaign) => campaign.id);

  const [deliveryRows, attemptRows, suppressionRows] = await Promise.all([
    getDb().execute<{ campaignId: string; key: string; count: number | string }>(sql`
      SELECT campaign_id AS "campaignId", status AS key, count(*)::int AS count
      FROM notification_deliveries
      WHERE campaign_id = ANY(${uuidArray(campaignIds)})
      GROUP BY campaign_id, status
    `),
    getDb().execute<{ campaignId: string; key: string; count: number | string }>(sql`
      SELECT campaign_id AS "campaignId", outcome AS key, count(*)::int AS count
      FROM notification_delivery_attempts
      WHERE campaign_id = ANY(${uuidArray(campaignIds)})
      GROUP BY campaign_id, outcome
    `),
    getDb().execute<{ campaignId: string; count: number | string }>(sql`
      SELECT "campaignId", count(DISTINCT suppression_id)::int AS count
      FROM (
        SELECT d.campaign_id AS "campaignId", s.id AS suppression_id
        FROM notification_deliveries d
        JOIN notification_suppressions s ON s.first_delivery_id = d.id
        WHERE d.campaign_id = ANY(${uuidArray(campaignIds)})
        UNION
        SELECT d.campaign_id AS "campaignId", s.id AS suppression_id
        FROM notification_deliveries d
        JOIN notification_suppressions s ON s.last_delivery_id = d.id
        WHERE d.campaign_id = ANY(${uuidArray(campaignIds)})
      ) suppression_links
      GROUP BY "campaignId"
    `),
  ]);

  const deliveriesByCampaign = groupedCountMap(deliveryRows);
  const attemptsByCampaign = groupedCountMap(attemptRows);
  const suppressionsByCampaign = numericCountMap(suppressionRows);

  return campaigns.map(
    (campaign) =>
      ({
        ...campaign,
        deliveryCounts: deliveriesByCampaign.get(campaign.id) ?? {},
        attemptCounts: attemptsByCampaign.get(campaign.id) ?? {},
        suppressionCount: suppressionsByCampaign.get(campaign.id) ?? 0,
      }) satisfies NotificationCampaignAdminSummary,
  );
}

export async function listNotificationCampaignAdminSummaries(): Promise<
  NotificationCampaignAdminSummary[]
> {
  const campaigns = await campaignBaseQuery()
    .orderBy(desc(notificationCampaigns.createdAt), desc(notificationCampaigns.id))
    .limit(50);
  return hydrateCampaignSummaries(campaigns);
}

export async function getNotificationCampaignAdminSummary(
  campaignId: string,
): Promise<NotificationCampaignAdminSummary | null> {
  const campaigns = await campaignBaseQuery()
    .where(eq(notificationCampaigns.id, campaignId))
    .limit(1);
  return (await hydrateCampaignSummaries(campaigns))[0] ?? null;
}
