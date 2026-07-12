import { createHash } from "crypto";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { type DbClient, getDb } from "@/db";
import {
  memberships,
  membershipTiers,
  notificationCampaigns,
  notificationDeliveries,
  notificationDeliveryAttempts,
  notificationPreferences,
  notificationQuotaWindows,
  notificationSuppressions,
  posts,
  postTranslations,
  type Task,
  tasks,
  users,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getSmtpConfig } from "@/modules/config";
import {
  buildPostUrl,
  buildPublicUrl,
  getPublicBaseUrl,
} from "@/modules/content/public-projection";
import { isLocale, type Locale } from "@/modules/i18n";
import { renderNewPostNotificationEmail, sendNewPostNotificationEmail } from "@/modules/mail";
import {
  classifyMailError,
  MailDeliveryError,
  type MailFailureKind,
} from "@/modules/mail/delivery";
import { enqueueCampaignFinalizeForDeliveryTx } from "@/modules/notifications/expansion";
import { generateNotificationUnsubscribeToken } from "@/modules/notifications/unsubscribe-token";
import {
  createNotificationSuppressionDigest,
  createNotificationSuppressionDigestCandidates,
  getNotificationSuppressionDigestKeys,
} from "@/modules/security/notification-suppression-key";
import { getNotificationUnsubscribeKeys } from "@/modules/security/notification-unsubscribe-key";
import { PermanentTaskError } from "@/modules/tasks/errors";
import type { TaskHandlerResult } from "@/modules/tasks/handlers";

const notificationDeliveryPayloadSchema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
});

export type NotificationDeliveryPayload = z.infer<typeof notificationDeliveryPayloadSchema>;

type TerminalDeliveryStatus = "accepted" | "suppressed" | "skipped" | "dead";
type DeliveryOutcome =
  | "started"
  | "accepted"
  | "permanent_failure"
  | "transient_failure"
  | "needs_operator_defer"
  | "lease_expired"
  | "budget_defer"
  | "pacing_defer"
  | "suppressed_skip"
  | "stale_skip"
  | "post_not_published_skip"
  | "access_lost_skip"
  | "preference_disabled_skip"
  | "user_missing_skip";

type PreparedMessage = {
  attemptId: string;
  attemptNumber: number;
  taskId: string;
  taskLockToken: string;
  finalAttempt: boolean;
  deliveryId: string;
  campaignId: string;
  recipientEmail: string;
  recipientLocale: Locale;
  recipientDigest: string;
  title: string;
  summary: string | null;
  postUrl: string;
  unsubscribeConfirmUrl: string;
  unsubscribeOneClickUrl: string;
  siteName: string;
};

type DeliveryPreparation =
  | { kind: "send"; message: PreparedMessage }
  | { kind: "done" }
  | { kind: "defer"; deferUntil: Date };

const NONTERMINAL_DELIVERY_STATUSES = ["queued", "sending", "deferred", "failed"] as const;

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function utcMinuteStart(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
    ),
  );
}

function deterministicJitterMs(id: string, maxMs: number): number {
  const digest = createHash("sha256").update(id).digest();
  return digest.readUInt32BE(0) % maxMs;
}

function nextUtcMidnightWithJitter(now: Date, id: string): Date {
  return new Date(
    utcDayStart(new Date(now.getTime() + 24 * 60 * 60 * 1000)).getTime() +
      deterministicJitterMs(id, 60_000),
  );
}

function nextMinuteWithJitter(now: Date, id: string): Date {
  const next = utcMinuteStart(new Date(now.getTime() + 60_000));
  return new Date(next.getTime() + deterministicJitterMs(id, 5_000));
}

function operatorDeferUntil(now: Date): Date {
  return new Date(now.getTime() + getEnv().EMAIL_RETRY_RECHECK_MINUTES * 60_000);
}

function expired(createdAt: Date, now: Date): boolean {
  return (
    now.getTime() - createdAt.getTime() >
    getEnv().NOTIFICATION_DELIVERY_MAX_AGE_HOURS * 60 * 60 * 1000
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function insertAttemptAndSetDeliveryTx(
  tx: DbClient,
  input: {
    deliveryId: string;
    campaignId: string;
    userId: string;
    taskId: string;
    outcome: DeliveryOutcome;
    status: typeof notificationDeliveries.$inferSelect.status;
    smtpAttempted?: boolean;
    recipientLocale?: string | null;
    recipientDigestKeyId?: string | null;
    recipientDigest?: string | null;
    messageSnapshot?: Record<string, unknown> | null;
    errorKind?: string | null;
    reservedUtcDay?: Date | null;
    reservedMinute?: Date | null;
    operatorRecheckCount?: number;
    operatorLastCheckedAt?: Date | SQL | null;
    nextAttemptAfter?: Date | null;
    lastError?: string | null;
    completed?: boolean;
  },
) {
  const [delivery] = await tx
    .update(notificationDeliveries)
    .set({
      attemptCount: sql`${notificationDeliveries.attemptCount} + 1`,
      status: input.status,
      lastAttemptAt: sql`now()`,
      nextAttemptAfter: input.nextAttemptAfter ?? null,
      lastOutcome: input.outcome,
      lastError: input.lastError ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(notificationDeliveries.id, input.deliveryId))
    .returning({ attemptCount: notificationDeliveries.attemptCount });
  if (!delivery) throw new PermanentTaskError("Notification delivery missing during attempt");

  const [attempt] = await tx
    .insert(notificationDeliveryAttempts)
    .values({
      deliveryId: input.deliveryId,
      campaignId: input.campaignId,
      userId: input.userId,
      taskId: input.taskId,
      attemptNumber: delivery.attemptCount,
      attemptUtcDay: sql`(now() at time zone 'utc')::date`,
      attemptMinute: sql`date_trunc('minute', now())`,
      reservedUtcDay: input.reservedUtcDay ?? null,
      reservedMinute: input.reservedMinute ?? null,
      smtpAttempted: input.smtpAttempted ?? false,
      outcome: input.outcome,
      recipientLocale: input.recipientLocale ?? null,
      recipientDigestKeyId: input.recipientDigestKeyId ?? null,
      recipientDigest: input.recipientDigest ?? null,
      messageSnapshot: input.messageSnapshot ?? null,
      errorKind: input.errorKind ?? null,
      operatorRecheckCount: input.operatorRecheckCount ?? 0,
      operatorLastCheckedAt: input.operatorLastCheckedAt ?? null,
      completedAt: input.completed ? sql`now()` : null,
    })
    .returning({
      id: notificationDeliveryAttempts.id,
      attemptNumber: notificationDeliveryAttempts.attemptNumber,
    });
  if (!attempt) throw new Error("Notification delivery attempt insert failed");
  return attempt;
}

async function lockDeliveryGraphTx(tx: DbClient, task: Task, userId: string) {
  // Task ownership fence first: a worker whose lease was reclaimed must stop
  // before any attempt, quota, or SMTP work — finish fencing alone cannot
  // recall a mail that was already handed to the SMTP server. This also pins
  // the global lock order (task -> delivery -> campaign -> attempt) shared
  // with the final-attempt sweep; taking campaign before delivery here while
  // the sweep does the opposite is a real 40P01 deadlock.
  const [ownedTask] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.status, "processing"),
        eq(tasks.lockedBy, task.lockedBy ?? ""),
      ),
    )
    .limit(1)
    .for("update");
  if (!ownedTask) return null;

  const [delivery] = await tx
    .select()
    .from(notificationDeliveries)
    .where(
      and(eq(notificationDeliveries.taskId, task.id), eq(notificationDeliveries.userId, userId)),
    )
    .limit(1)
    .for("update");
  if (!delivery) throw new PermanentTaskError("Notification delivery link missing");

  const [campaign] = await tx
    .select()
    .from(notificationCampaigns)
    .where(eq(notificationCampaigns.id, delivery.campaignId))
    .limit(1)
    .for("update");
  if (!campaign) throw new PermanentTaskError("Notification campaign link missing");

  const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
  const [preference] = await tx
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1)
    .for("update");
  const [post] = await tx
    .select()
    .from(posts)
    .where(eq(posts.id, campaign.postId))
    .limit(1)
    .for("update");

  return { campaign, delivery, user, preference, post };
}

async function hasCurrentAccessTx(
  tx: DbClient,
  post: typeof posts.$inferSelect,
  userId: string,
): Promise<boolean> {
  if (post.visibility !== "member") return true;
  if (!post.requiredTierId) return false;
  const [requiredTier] = await tx
    .select({ level: membershipTiers.level })
    .from(membershipTiers)
    .where(eq(membershipTiers.id, post.requiredTierId))
    .limit(1)
    .for("update");
  if (!requiredTier) return false;
  const [membership] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(membershipTiers, eq(membershipTiers.id, memberships.tierId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        sql`${memberships.startsAt} <= now()`,
        sql`${memberships.endsAt} > now()`,
        sql`${membershipTiers.level} >= ${requiredTier.level}`,
      ),
    )
    .limit(1)
    .for("update");
  return Boolean(membership);
}

async function resolveLocalizedPostTx(
  tx: DbClient,
  post: typeof posts.$inferSelect,
  locale: Locale,
): Promise<{ title: string; summary: string | null }> {
  if (post.originalLocale === locale) return { title: post.title, summary: post.summary };
  const [translation] = await tx
    .select()
    .from(postTranslations)
    .where(
      and(
        eq(postTranslations.postId, post.id),
        eq(postTranslations.locale, locale),
        eq(postTranslations.status, "published"),
      ),
    )
    .limit(1);
  return {
    title: translation?.title ?? post.title,
    summary: translation?.summary ?? post.summary,
  };
}

async function findSuppressionTx(tx: DbClient, email: string): Promise<boolean> {
  const candidates = createNotificationSuppressionDigestCandidates(email);
  if (candidates.length === 0) return false;
  const condition = candidates
    .map(
      (candidate) =>
        sql`(${notificationSuppressions.emailDigestKeyId} = ${candidate.keyId} AND ${notificationSuppressions.emailDigest} = ${candidate.digest})`,
    )
    .reduce((left, right) => sql`${left} OR ${right}`);
  const rows = await tx
    .select({ id: notificationSuppressions.id })
    .from(notificationSuppressions)
    .where(condition)
    .limit(1)
    .for("update");
  return rows.length > 0;
}

async function reserveQuotaTx(
  tx: DbClient,
  input: { deliveryId: string },
): Promise<
  | { ok: true; reservedUtcDay: Date; reservedMinute: Date }
  | { ok: false; outcome: "budget_defer" | "pacing_defer"; deferUntil: Date }
> {
  const env = getEnv();
  const [clock] = await tx.execute<{
    db_now: Date;
    day_start: Date;
    minute_start: Date;
    reserved_utc_day: string;
  }>(sql`
    SELECT
      now() AS db_now,
      date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc' AS day_start,
      date_trunc('minute', now()) AS minute_start,
      ((now() AT TIME ZONE 'utc')::date)::text AS reserved_utc_day
  `);
  if (!clock) throw new Error("Notification quota clock read failed");
  // postgres.js may return raw SQL timestamps as strings — coerce before
  // handing them to drizzle timestamp columns.
  const dayStart = new Date(clock.day_start);
  const minuteStart = new Date(clock.minute_start);
  const reservedUtcDay = new Date(`${clock.reserved_utc_day}T00:00:00.000Z`);
  await tx
    .insert(notificationQuotaWindows)
    .values([
      { windowKind: "utc_day", windowStart: dayStart, attemptedCount: 0 },
      { windowKind: "utc_minute", windowStart: minuteStart, attemptedCount: 0 },
    ])
    .onConflictDoNothing();

  const rows = await tx.execute<{
    window_kind: "utc_day" | "utc_minute";
    attempted_count: number;
  }>(sql`
    SELECT window_kind, attempted_count
    FROM notification_quota_windows
    WHERE (window_kind, window_start) IN (
      ('utc_day', ${dayStart.toISOString()}::timestamptz),
      ('utc_minute', ${minuteStart.toISOString()}::timestamptz)
    )
    ORDER BY window_kind ASC, window_start ASC
    FOR UPDATE
  `);
  const day = rows.find((row) => row.window_kind === "utc_day");
  const minute = rows.find((row) => row.window_kind === "utc_minute");
  if (!day || !minute) throw new Error("Notification quota window lock failed");

  if (day.attempted_count >= env.NOTIFICATION_EMAIL_DAILY_BUDGET) {
    return {
      ok: false,
      outcome: "budget_defer",
      deferUntil: nextUtcMidnightWithJitter(new Date(clock.db_now), input.deliveryId),
    };
  }
  if (minute.attempted_count >= env.NOTIFICATION_EMAIL_PACING_PER_MINUTE) {
    return {
      ok: false,
      outcome: "pacing_defer",
      deferUntil: nextMinuteWithJitter(new Date(clock.db_now), input.deliveryId),
    };
  }

  await tx.execute(sql`
    UPDATE notification_quota_windows
    SET attempted_count = attempted_count + 1,
        updated_at = now()
    WHERE (window_kind, window_start) IN (
      ('utc_day', ${dayStart.toISOString()}::timestamptz),
      ('utc_minute', ${minuteStart.toISOString()}::timestamptz)
    )
  `);
  return { ok: true, reservedUtcDay, reservedMinute: minuteStart };
}

async function recordNeedsOperatorDeferTx(
  tx: DbClient,
  input: {
    campaignId: string;
    delivery: typeof notificationDeliveries.$inferSelect;
    task: Task;
    reason: string;
    terminal: boolean;
    deferUntil: Date;
  },
) {
  const [latest] = await tx
    .select({
      id: notificationDeliveryAttempts.id,
      outcome: notificationDeliveryAttempts.outcome,
      completedAt: notificationDeliveryAttempts.completedAt,
    })
    .from(notificationDeliveryAttempts)
    .where(eq(notificationDeliveryAttempts.deliveryId, input.delivery.id))
    .orderBy(desc(notificationDeliveryAttempts.attemptNumber))
    .limit(1)
    .for("update");
  const status = input.terminal ? "dead" : "deferred";
  const lastError = input.terminal
    ? `${input.reason}; notification delivery expired`
    : input.reason;

  if (latest?.outcome === "needs_operator_defer" && !latest.completedAt) {
    await tx
      .update(notificationDeliveryAttempts)
      .set({
        operatorRecheckCount: sql`${notificationDeliveryAttempts.operatorRecheckCount} + 1`,
        operatorLastCheckedAt: sql`now()`,
        completedAt: input.terminal ? sql`now()` : null,
      })
      .where(eq(notificationDeliveryAttempts.id, latest.id));
    await tx
      .update(notificationDeliveries)
      .set({
        status,
        lastOutcome: "needs_operator_defer",
        lastError,
        nextAttemptAfter: input.terminal ? null : input.deferUntil,
        updatedAt: sql`now()`,
      })
      .where(eq(notificationDeliveries.id, input.delivery.id));
    return;
  }

  await insertAttemptAndSetDeliveryTx(tx, {
    deliveryId: input.delivery.id,
    campaignId: input.campaignId,
    userId: input.delivery.userId,
    taskId: input.task.id,
    outcome: "needs_operator_defer",
    status,
    smtpAttempted: false,
    nextAttemptAfter: input.terminal ? null : input.deferUntil,
    lastError,
    completed: input.terminal,
    operatorRecheckCount: 1,
    operatorLastCheckedAt: sql`now()`,
  });
}

async function preflightNeedsOperatorTx(
  task: Task,
  userId: string,
  reason = "SMTP unavailable; delivery deferred",
): Promise<DeliveryPreparation> {
  const now = new Date();
  return getDb().transaction(async (tx) => {
    const graph = await lockDeliveryGraphTx(tx, task, userId);
    if (!graph) return { kind: "done" };
    const { campaign, delivery } = graph;
    if (
      !NONTERMINAL_DELIVERY_STATUSES.includes(
        delivery.status as (typeof NONTERMINAL_DELIVERY_STATUSES)[number],
      )
    )
      return { kind: "done" };
    const terminal = expired(delivery.createdAt, now);
    const deferUntil = operatorDeferUntil(now);
    await recordNeedsOperatorDeferTx(tx, {
      campaignId: campaign.id,
      delivery,
      task,
      reason,
      terminal,
      deferUntil,
    });
    if (terminal) {
      await enqueueCampaignFinalizeForDeliveryTx(tx, campaign.id);
      return { kind: "done" };
    }
    return { kind: "defer", deferUntil };
  });
}

async function prepareDeliveryTx(task: Task, userId: string): Promise<DeliveryPreparation> {
  const now = new Date();
  return getDb().transaction(async (tx) => {
    const graph = await lockDeliveryGraphTx(tx, task, userId);
    if (!graph) return { kind: "done" };
    const { campaign, delivery, user, preference, post } = graph;
    if (
      !NONTERMINAL_DELIVERY_STATUSES.includes(
        delivery.status as (typeof NONTERMINAL_DELIVERY_STATUSES)[number],
      )
    )
      return { kind: "done" };

    async function terminalSkip(
      outcome: DeliveryOutcome,
      status: TerminalDeliveryStatus,
      lastError: string,
    ) {
      await insertAttemptAndSetDeliveryTx(tx, {
        deliveryId: delivery.id,
        campaignId: campaign.id,
        userId: delivery.userId,
        taskId: task.id,
        outcome,
        status,
        smtpAttempted: false,
        lastError,
        completed: true,
      });
      await enqueueCampaignFinalizeForDeliveryTx(tx, campaign.id);
      return { kind: "done" as const };
    }

    if (!user) return terminalSkip("user_missing_skip", "skipped", "recipient user missing");
    if (!preference?.newPostEmailEnabled)
      return terminalSkip(
        "preference_disabled_skip",
        "skipped",
        "recipient notification preference disabled",
      );

    const currentDigest = createNotificationSuppressionDigest(user.email);
    if (await findSuppressionTx(tx, user.email)) {
      await insertAttemptAndSetDeliveryTx(tx, {
        deliveryId: delivery.id,
        campaignId: campaign.id,
        userId: delivery.userId,
        taskId: task.id,
        outcome: "suppressed_skip",
        status: "suppressed",
        smtpAttempted: false,
        recipientDigestKeyId: currentDigest.keyId,
        recipientDigest: currentDigest.digest,
        lastError: "recipient is suppressed for notification email",
        completed: true,
      });
      await enqueueCampaignFinalizeForDeliveryTx(tx, campaign.id);
      return { kind: "done" };
    }

    if (!post || post.status !== "published") {
      return terminalSkip("post_not_published_skip", "skipped", "post not published at send time");
    }
    if (!(await hasCurrentAccessTx(tx, post, user.id))) {
      return terminalSkip("access_lost_skip", "skipped", "recipient lost access before send");
    }
    if (expired(delivery.createdAt, now)) {
      return terminalSkip("stale_skip", "skipped", "notification delivery expired before send");
    }

    const locale: Locale = isLocale(user.locale) ? user.locale : "zh";
    const localized = await resolveLocalizedPostTx(tx, post, locale);
    const token = generateNotificationUnsubscribeToken({
      userId: user.id,
      preferenceVersion: preference.version,
      issuedAt: now,
    });
    // buildPublicUrl preserves an APP_URL path prefix (subpath deployments);
    // `new URL("/x", base)` would drop it and break every emailed link.
    const publicBaseUrl = getPublicBaseUrl(getEnv().APP_URL);
    const unsubscribeConfirmUrl = buildPublicUrl(
      publicBaseUrl,
      `/unsubscribe/notifications/${encodeURIComponent(token)}`,
    );
    const unsubscribeOneClickUrl = buildPublicUrl(
      publicBaseUrl,
      `/api/notifications/unsubscribe/${encodeURIComponent(token)}`,
    );
    const postUrl = buildPostUrl(publicBaseUrl, post.slug);
    const siteName = getEnv().APP_NAME;
    const rendered = renderNewPostNotificationEmail(
      {
        title: localized.title,
        summary: localized.summary,
        postUrl,
        unsubscribeConfirmUrl,
        siteName,
      },
      locale,
    );

    const quota = await reserveQuotaTx(tx, { deliveryId: delivery.id });
    if (!quota.ok) {
      await insertAttemptAndSetDeliveryTx(tx, {
        deliveryId: delivery.id,
        campaignId: campaign.id,
        userId: delivery.userId,
        taskId: task.id,
        outcome: quota.outcome,
        status: "deferred",
        smtpAttempted: false,
        recipientLocale: locale,
        recipientDigestKeyId: currentDigest.keyId,
        recipientDigest: currentDigest.digest,
        nextAttemptAfter: quota.deferUntil,
        lastError:
          quota.outcome === "budget_defer"
            ? "notification daily budget exhausted"
            : "notification pacing exhausted",
      });
      return { kind: "defer", deferUntil: quota.deferUntil };
    }

    const snapshot = {
      version: 1,
      campaignId: campaign.id,
      postId: post.id,
      recipientLocale: locale,
      titleHash: hashText(localized.title),
      titleLength: localized.title.length,
      summaryHash: localized.summary ? hashText(localized.summary) : null,
      summaryLength: localized.summary?.length ?? 0,
      subjectHash: hashText(rendered.subject),
      subjectLength: rendered.subject.length,
      textHash: hashText(rendered.text),
      textLength: rendered.text.length,
      postUrlHash: hashText(postUrl),
      unsubscribeUrlHash: hashText(unsubscribeConfirmUrl),
    };

    const attempt = await insertAttemptAndSetDeliveryTx(tx, {
      deliveryId: delivery.id,
      campaignId: campaign.id,
      userId: delivery.userId,
      taskId: task.id,
      outcome: "started",
      status: "sending",
      smtpAttempted: false,
      reservedUtcDay: quota.reservedUtcDay,
      reservedMinute: quota.reservedMinute,
      recipientLocale: locale,
      recipientDigestKeyId: currentDigest.keyId,
      recipientDigest: currentDigest.digest,
      messageSnapshot: snapshot,
    });

    await tx
      .update(notificationDeliveryAttempts)
      .set({ smtpAttempted: true })
      .where(eq(notificationDeliveryAttempts.id, attempt.id));

    return {
      kind: "send",
      message: {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        taskId: task.id,
        taskLockToken: task.lockedBy ?? "",
        finalAttempt: task.attempts >= task.maxAttempts,
        deliveryId: delivery.id,
        campaignId: campaign.id,
        recipientEmail: user.email,
        recipientLocale: locale,
        recipientDigest: currentDigest.digest,
        title: localized.title,
        summary: localized.summary,
        postUrl,
        unsubscribeConfirmUrl,
        unsubscribeOneClickUrl,
        siteName,
      },
    };
  });
}

async function isLatestAttemptHeldByTaskTx(
  tx: DbClient,
  message: PreparedMessage,
): Promise<boolean> {
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, message.taskId),
        eq(tasks.status, "processing"),
        eq(tasks.lockedBy, message.taskLockToken),
      ),
    )
    .limit(1)
    .for("update");
  if (!task) return false;

  const [delivery] = await tx
    .select({ attemptCount: notificationDeliveries.attemptCount })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, message.deliveryId))
    .limit(1)
    .for("update");
  return Boolean(delivery && delivery.attemptCount === message.attemptNumber);
}

async function finishAcceptedTx(message: PreparedMessage): Promise<void> {
  await getDb().transaction(async (tx) => {
    // Lock order must be task -> delivery -> attempt, matching the
    // final-attempt sweep; locking the attempt first deadlocks (40P01)
    // against a concurrent sweep that already holds the task row.
    const active = await isLatestAttemptHeldByTaskTx(tx, message);
    await tx
      .update(notificationDeliveryAttempts)
      .set({ outcome: "accepted", completedAt: sql`now()` })
      .where(
        and(
          eq(notificationDeliveryAttempts.id, message.attemptId),
          isNull(notificationDeliveryAttempts.completedAt),
        ),
      );
    if (!active) return;
    await tx
      .update(notificationDeliveries)
      .set({
        status: "accepted",
        lastOutcome: "accepted",
        lastError: null,
        nextAttemptAfter: null,
        updatedAt: sql`now()`,
      })
      .where(eq(notificationDeliveries.id, message.deliveryId));
    await enqueueCampaignFinalizeForDeliveryTx(tx, message.campaignId);
  });
}

async function finishFailureTx(
  message: PreparedMessage,
  kind: MailFailureKind,
): Promise<TaskHandlerResult> {
  const now = new Date();
  if (kind === "permanent") {
    await getDb().transaction(async (tx) => {
      // Same task -> delivery -> attempt lock order as the sweep.
      const active = await isLatestAttemptHeldByTaskTx(tx, message);
      await tx
        .update(notificationDeliveryAttempts)
        .set({ outcome: "permanent_failure", errorKind: "permanent", completedAt: sql`now()` })
        .where(
          and(
            eq(notificationDeliveryAttempts.id, message.attemptId),
            isNull(notificationDeliveryAttempts.completedAt),
          ),
        );
      if (!active) return;
      await tx
        .update(notificationDeliveries)
        .set({
          status: "dead",
          lastOutcome: "permanent_failure",
          lastError: "SMTP permanent rejection",
          nextAttemptAfter: null,
          updatedAt: sql`now()`,
        })
        .where(eq(notificationDeliveries.id, message.deliveryId));
      const digest = createNotificationSuppressionDigest(message.recipientEmail);
      await tx
        .insert(notificationSuppressions)
        .values({
          emailDigestKeyId: digest.keyId,
          emailDigest: digest.digest,
          reason: "smtp_permanent_5xx",
          firstDeliveryId: message.deliveryId,
          lastDeliveryId: message.deliveryId,
        })
        .onConflictDoUpdate({
          target: [notificationSuppressions.emailDigestKeyId, notificationSuppressions.emailDigest],
          set: { lastDeliveryId: message.deliveryId, updatedAt: sql`now()` },
        });
      await enqueueCampaignFinalizeForDeliveryTx(tx, message.campaignId);
    });
    throw new PermanentTaskError("Notification email delivery failed permanently", {
      classification: "permanent",
    });
  }

  if (kind === "needs_operator") {
    const deferUntil = operatorDeferUntil(now);
    let terminal = false;
    await getDb().transaction(async (tx) => {
      // Same task -> delivery -> attempt lock order as the sweep.
      const active = await isLatestAttemptHeldByTaskTx(tx, message);
      const [delivery] = await tx
        .select({ createdAt: notificationDeliveries.createdAt })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.id, message.deliveryId))
        .limit(1)
        .for("update");
      terminal = active && delivery ? expired(delivery.createdAt, now) : false;
      // This branch only runs after the transport was invoked (e.g. EAUTH),
      // so the attempt consumed a real SMTP connection: keep
      // smtpAttempted=true and do not refund the day/minute quota windows —
      // otherwise a broken SMTP config lets a large campaign hammer the
      // server far past the configured pacing and daily budget.
      await tx
        .update(notificationDeliveryAttempts)
        .set({
          outcome: "needs_operator_defer",
          errorKind: "needs_operator",
          completedAt: sql`now()`,
        })
        .where(
          and(
            eq(notificationDeliveryAttempts.id, message.attemptId),
            isNull(notificationDeliveryAttempts.completedAt),
          ),
        );
      if (!active) return;
      await tx
        .update(notificationDeliveries)
        .set({
          status: terminal ? "dead" : "deferred",
          lastOutcome: "needs_operator_defer",
          lastError: terminal
            ? "SMTP operator issue; notification expired"
            : "SMTP operator issue; delivery deferred",
          nextAttemptAfter: terminal ? null : deferUntil,
          updatedAt: sql`now()`,
        })
        .where(eq(notificationDeliveries.id, message.deliveryId));
      if (terminal) await enqueueCampaignFinalizeForDeliveryTx(tx, message.campaignId);
    });
    // A terminal delivery is done: returning a defer here would re-pend the
    // task and run it once more against an already-dead delivery.
    return terminal ? {} : { deferUntil };
  }

  await getDb().transaction(async (tx) => {
    // Same task -> delivery -> attempt lock order as the sweep.
    const active = await isLatestAttemptHeldByTaskTx(tx, message);
    await tx
      .update(notificationDeliveryAttempts)
      .set({ outcome: "transient_failure", errorKind: "transient", completedAt: sql`now()` })
      .where(
        and(
          eq(notificationDeliveryAttempts.id, message.attemptId),
          isNull(notificationDeliveryAttempts.completedAt),
        ),
      );
    if (!active) return;
    // On the task's final attempt the dispatcher dead-letters the task after
    // this throw, so the delivery must reach a terminal state here or the
    // campaign finalizer would defer forever.
    await tx
      .update(notificationDeliveries)
      .set({
        status: message.finalAttempt ? "dead" : "failed",
        lastOutcome: "transient_failure",
        lastError: message.finalAttempt
          ? "SMTP transient failure; retries exhausted"
          : "SMTP transient failure",
        updatedAt: sql`now()`,
      })
      .where(eq(notificationDeliveries.id, message.deliveryId));
    if (message.finalAttempt) await enqueueCampaignFinalizeForDeliveryTx(tx, message.campaignId);
  });
  throw new MailDeliveryError("transient");
}

export async function handleNotificationDeliveryTask(task: Task): Promise<TaskHandlerResult> {
  const parsed = notificationDeliveryPayloadSchema.safeParse(task.payloadJson);
  if (!parsed.success) throw new PermanentTaskError("Invalid notification delivery payload");

  const smtpConfig = await getSmtpConfig();
  if (!smtpConfig.configured) {
    const preflight = await preflightNeedsOperatorTx(task, parsed.data.userId);
    return preflight.kind === "defer" ? { deferUntil: preflight.deferUntil } : {};
  }

  try {
    getNotificationSuppressionDigestKeys();
    getNotificationUnsubscribeKeys();
  } catch {
    const preflight = await preflightNeedsOperatorTx(
      task,
      parsed.data.userId,
      "notification email key unavailable; delivery deferred",
    );
    return preflight.kind === "defer" ? { deferUntil: preflight.deferUntil } : {};
  }

  const prepared = await prepareDeliveryTx(task, parsed.data.userId);
  if (prepared.kind === "defer") return { deferUntil: prepared.deferUntil };
  if (prepared.kind === "done") return {};

  const message = prepared.message;
  try {
    // SMTP accepted is at-least-once, not exactly-once. If the worker crashes
    // after the SMTP server accepts but before the post-SMTP transaction or task
    // success, a stale lease retry may send a duplicate and record a new attempt.
    await sendNewPostNotificationEmail(
      message.recipientEmail,
      {
        title: message.title,
        summary: message.summary,
        postUrl: message.postUrl,
        unsubscribeConfirmUrl: message.unsubscribeConfirmUrl,
        unsubscribeOneClickUrl: message.unsubscribeOneClickUrl,
        siteName: message.siteName,
      },
      message.recipientLocale,
      {},
      {
        template: "new_post_notification",
        category: "notification",
        campaignId: message.campaignId,
        deliveryId: message.deliveryId,
        attemptId: message.attemptId,
        recipientDigest: message.recipientDigest,
      },
    );
  } catch (error) {
    return finishFailureTx(message, classifyMailError(error));
  }
  await finishAcceptedTx(message);
  return {};
}
