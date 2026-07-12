import type { DbClient } from "@/db";
import { notificationCampaigns, type Post } from "@/db/schema";
import { enqueueTask } from "@/modules/tasks";

export type NotificationCampaignSource = "manual_publish" | "scheduled_publish";

export type CreateCampaignForPublishedPostInput = {
  post: Post;
  before: Post;
  after: Post;
  source: NotificationCampaignSource;
  correlationId: string;
  causationId?: string | null;
};

export async function createCampaignForPublishedPostTx(
  tx: DbClient,
  input: CreateCampaignForPublishedPostInput,
): Promise<string | null> {
  void input.before;
  void input.correlationId;
  void input.causationId;

  const rows = await tx
    .insert(notificationCampaigns)
    .values({
      postId: input.post.id,
      source: input.source,
      publishedAt: input.after.publishedAt ?? new Date(),
    })
    .onConflictDoNothing({ target: notificationCampaigns.postId })
    .returning({ id: notificationCampaigns.id });
  const campaign = rows[0];
  if (!campaign) return null;

  await enqueueTask(tx, {
    kind: "notification.campaign_expand",
    dedupeKey: `notification:campaign_expand:${campaign.id}`,
    payload: { version: 1, campaignId: campaign.id },
    queueClass: "notification",
    priority: 80,
  });

  return campaign.id;
}
