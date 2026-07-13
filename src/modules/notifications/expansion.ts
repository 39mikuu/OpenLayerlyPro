import { randomUUID } from "crypto";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { type DbClient, getDb } from "@/db";
import { membershipTiers, notificationCampaigns, notificationDeliveries, posts } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { enqueueTask, enqueueTaskReturningId } from "@/modules/tasks";
import { PermanentTaskError } from "@/modules/tasks/errors";
import type { TaskHandlerResult } from "@/modules/tasks/handlers";

const campaignExpandPayloadSchema = z.object({
  version: z.literal(1),
  campaignId: z.string().uuid(),
});

const campaignFinalizePayloadSchema = z.object({
  version: z.literal(1),
  campaignId: z.string().uuid(),
});

export type CampaignExpandPayload = z.infer<typeof campaignExpandPayloadSchema>;
export type CampaignFinalizePayload = z.infer<typeof campaignFinalizePayloadSchema>;

type CampaignExpandOptions = {
  batchSize?: number;
};

type RecipientCandidate = {
  user_id: string;
};

function oneSecondFromNow(): Date {
  return new Date(Date.now() + 1_000);
}

function oneMinuteFromNow(): Date {
  return new Date(Date.now() + 60_000);
}

function fiveMinutesFromNow(): Date {
  return new Date(Date.now() + 5 * 60_000);
}

// Exported unexecuted so the integration suite can EXPLAIN the exact
// production query shape (same pattern as the feed/sitemap plan proofs).
export function expansionRecipientQuery(input: {
  cursorUserId: string | null;
  limit: number;
  requiredTierLevel: number | null;
}): SQL {
  const memberFilter =
    input.requiredTierLevel === null
      ? sql``
      : sql`
      AND EXISTS (
        SELECT 1
        FROM memberships m
        INNER JOIN membership_tiers mt ON mt.id = m.tier_id
        WHERE m.user_id = u.id
          AND m.status = 'active'
          AND m.starts_at <= now()
          AND m.ends_at > now()
          AND mt.level >= ${input.requiredTierLevel}
      )`;
  return sql`
    SELECT u.id AS user_id
    FROM users u
    INNER JOIN notification_preferences np
      ON np.user_id = u.id
     AND np.new_post_email_enabled = true
    WHERE (${input.cursorUserId}::uuid IS NULL OR u.id > ${input.cursorUserId}::uuid)${memberFilter}
    ORDER BY u.id ASC
    LIMIT ${input.limit}
  `;
}

async function selectRecipientCandidates(
  tx: DbClient,
  input: {
    visibility: "public" | "login" | "member";
    requiredTierId: string | null;
    cursorUserId: string | null;
    limit: number;
  },
): Promise<RecipientCandidate[]> {
  if (input.visibility !== "member") {
    return tx.execute<RecipientCandidate>(
      expansionRecipientQuery({
        cursorUserId: input.cursorUserId,
        limit: input.limit,
        requiredTierLevel: null,
      }),
    );
  }

  if (!input.requiredTierId) return [];
  const [requiredTier] = await tx
    .select({ level: membershipTiers.level })
    .from(membershipTiers)
    .where(eq(membershipTiers.id, input.requiredTierId))
    .limit(1);
  if (!requiredTier) return [];

  return tx.execute<RecipientCandidate>(
    expansionRecipientQuery({
      cursorUserId: input.cursorUserId,
      limit: input.limit,
      requiredTierLevel: requiredTier.level,
    }),
  );
}

async function createDeliveryAndTaskTx(
  tx: DbClient,
  input: { campaignId: string; userId: string },
): Promise<void> {
  const deliveryId = randomUUID();
  const taskId = randomUUID();
  const [delivery] = await tx
    .insert(notificationDeliveries)
    .values({
      id: deliveryId,
      campaignId: input.campaignId,
      userId: input.userId,
      taskId,
    })
    .onConflictDoNothing({
      target: [notificationDeliveries.campaignId, notificationDeliveries.userId],
    })
    .returning({ id: notificationDeliveries.id });

  if (!delivery) return;

  const linkedTaskId = await enqueueTaskReturningId(tx, {
    id: taskId,
    kind: "notification.deliver",
    dedupeKey: `notification:delivery:${deliveryId}`,
    payload: { version: 1, userId: input.userId },
    maxAttempts: 5,
    priority: 90,
    queueClass: "notification",
  });

  if (linkedTaskId !== taskId) {
    throw new Error("Notification delivery task dedupe resolved to an unexpected task");
  }
}

async function enqueueCampaignFinalizeTx(
  tx: DbClient,
  campaignId: string,
  runAfter?: Date,
): Promise<void> {
  await enqueueTask(tx, {
    kind: "notification.campaign_finalize",
    dedupeKey: `notification:campaign_finalize:${campaignId}`,
    payload: { version: 1, campaignId },
    runAfter,
    maxAttempts: 5,
    priority: 95,
    queueClass: "notification",
  });
}

async function completeExpansionTx(tx: DbClient, campaignId: string): Promise<void> {
  // Only the zero/nonzero decision matters here — probe one row instead of
  // counting the whole recipient set so completion stays bounded.
  const rows = await tx.execute<{ present: number }>(sql`
    SELECT 1 AS present
    FROM notification_deliveries
    WHERE campaign_id = ${campaignId}
    LIMIT 1
  `);
  const hasDeliveries = rows.length > 0;
  await tx
    .update(notificationCampaigns)
    .set({
      status: hasDeliveries ? "sending" : "completed",
      expansionCompletedAt: sql`now()`,
      completedAt: hasDeliveries ? null : sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(notificationCampaigns.id, campaignId));
  await enqueueCampaignFinalizeTx(tx, campaignId);
}

export async function handleCampaignExpandTask(
  payloadJson: unknown,
  options: CampaignExpandOptions = {},
): Promise<TaskHandlerResult> {
  const parsed = campaignExpandPayloadSchema.safeParse(payloadJson);
  if (!parsed.success) {
    throw new PermanentTaskError("Invalid notification campaign expansion payload");
  }

  const batchSize = options.batchSize ?? getEnv().NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE;
  return getDb().transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(notificationCampaigns)
      .where(eq(notificationCampaigns.id, parsed.data.campaignId))
      .limit(1)
      .for("update");
    if (!campaign) throw new PermanentTaskError("Notification campaign missing");
    if (campaign.status === "completed" || campaign.status === "dead") return {};

    const [post] = await tx
      .select()
      .from(posts)
      .where(eq(posts.id, campaign.postId))
      .limit(1)
      .for("update");

    if (!post) {
      await tx
        .update(notificationCampaigns)
        .set({ status: "dead", lastError: "post_missing_before_expansion", updatedAt: sql`now()` })
        .where(eq(notificationCampaigns.id, campaign.id));
      return {};
    }

    if (post.status !== "published") {
      await tx
        .update(notificationCampaigns)
        .set({
          status: "completed",
          lastError: "post_not_published_before_expansion",
          expansionCompletedAt: sql`now()`,
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(notificationCampaigns.id, campaign.id));
      return {};
    }

    await tx
      .update(notificationCampaigns)
      .set({ status: "expanding", updatedAt: sql`now()` })
      .where(eq(notificationCampaigns.id, campaign.id));

    const candidates = await selectRecipientCandidates(tx, {
      visibility: post.visibility,
      requiredTierId: post.requiredTierId,
      cursorUserId: campaign.cursorUserId,
      limit: batchSize,
    });

    for (const candidate of candidates) {
      await createDeliveryAndTaskTx(tx, {
        campaignId: campaign.id,
        userId: candidate.user_id,
      });
    }

    const lastUserId = candidates.at(-1)?.user_id ?? campaign.cursorUserId;
    await tx
      .update(notificationCampaigns)
      .set({ cursorUserId: lastUserId ?? null, updatedAt: sql`now()` })
      .where(eq(notificationCampaigns.id, campaign.id));

    if (candidates.length < batchSize) {
      await completeExpansionTx(tx, campaign.id);
      return {};
    }

    const deferUntil = oneSecondFromNow();
    await enqueueTask(tx, {
      kind: "notification.campaign_expand",
      dedupeKey: `notification:campaign_expand:${campaign.id}`,
      payload: { version: 1, campaignId: campaign.id },
      runAfter: deferUntil,
      maxAttempts: 5,
      priority: 80,
      queueClass: "notification",
    });
    return { deferUntil };
  });
}

export async function handleCampaignFinalizeTask(payloadJson: unknown): Promise<TaskHandlerResult> {
  const parsed = campaignFinalizePayloadSchema.safeParse(payloadJson);
  if (!parsed.success) {
    throw new PermanentTaskError("Invalid notification campaign finalize payload");
  }

  return getDb().transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(notificationCampaigns)
      .where(eq(notificationCampaigns.id, parsed.data.campaignId))
      .limit(1)
      .for("update");
    if (!campaign) throw new PermanentTaskError("Notification campaign missing");
    if (campaign.status === "completed" || campaign.status === "dead") return {};

    if (!campaign.expansionCompletedAt) {
      return { deferUntil: oneMinuteFromNow() };
    }

    const [nonterminal] = await tx
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.campaignId, campaign.id),
          inArray(notificationDeliveries.status, ["queued", "sending", "deferred", "failed"]),
        ),
      )
      .limit(1);

    if (nonterminal) {
      await tx
        .update(notificationCampaigns)
        .set({ status: "sending", updatedAt: sql`now()` })
        .where(eq(notificationCampaigns.id, campaign.id));
      return { deferUntil: fiveMinutesFromNow() };
    }

    await tx
      .update(notificationCampaigns)
      .set({ status: "completed", completedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(notificationCampaigns.id, campaign.id));
    return {};
  });
}

export async function enqueueCampaignFinalizeForDeliveryTx(
  tx: DbClient,
  campaignId: string,
): Promise<void> {
  await enqueueCampaignFinalizeTx(tx, campaignId);
}
