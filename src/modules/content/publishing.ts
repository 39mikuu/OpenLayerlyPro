import { randomUUID } from "crypto";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { type Post, posts } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { type AuditActor, pickPostPublishingAudit, recordAudit } from "@/modules/audit";
import { createCampaignForPublishedPostTx } from "@/modules/notifications";
import { enqueueTask } from "@/modules/tasks";

export type PublishingActor = AuditActor;

export type DerivedPostState = "draft" | "scheduled" | "published" | "archived";

export type ScheduledPublishResult =
  | { outcome: "published"; note?: string }
  | { outcome: "noop"; note?: string }
  | { outcome: "defer"; note?: string; deferUntil: Date };

type PublishingDependencies = {
  createId: () => string;
  enqueue: typeof enqueueTask;
  audit: typeof recordAudit;
  createCampaign: typeof createCampaignForPublishedPostTx;
};

const defaultDependencies: PublishingDependencies = {
  createId: randomUUID,
  enqueue: enqueueTask,
  audit: recordAudit,
  createCampaign: createCampaignForPublishedPostTx,
};

type PublishingDependencyOverrides = Partial<PublishingDependencies>;

function resolvePublishingDependencies(
  dependencies: PublishingDependencyOverrides,
): PublishingDependencies {
  return { ...defaultDependencies, ...dependencies };
}

export function derivePostState(post: Pick<Post, "status" | "scheduledAt">): DerivedPostState {
  if (post.status === "draft" && post.scheduledAt !== null) return "scheduled";
  return post.status;
}

async function databaseNow(tx: DbClient): Promise<Date> {
  const result = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  const row = result[0];
  if (!row) throw new Error("Failed to read database time");
  const now = row.now instanceof Date ? row.now : new Date(row.now);
  if (Number.isNaN(now.getTime())) throw new Error("Invalid database time");
  return now;
}

function assertFutureSchedule(scheduledAt: Date, now: Date): void {
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime()) {
    throw new ApiError(400, "postScheduleTooSoon");
  }
}

async function getPostForUpdate(tx: DbClient, postId: string): Promise<Post> {
  const [post] = await tx.select().from(posts).where(eq(posts.id, postId)).limit(1).for("update");
  if (!post) throw new ApiError(404, "postNotFound");
  return post;
}

async function throwPublishingStaleOrNotFound(tx: DbClient, postId: string): Promise<never> {
  const [post] = await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) throw new ApiError(404, "postNotFound");
  throw new ApiError(409, "postPublishingStale");
}

async function writePostAudit(
  tx: DbClient,
  dependencies: PublishingDependencies,
  input: {
    postId: string;
    action: string;
    actor: PublishingActor;
    before: Post;
    after: Post;
    correlationId: string;
    causationId?: string | null;
  },
): Promise<{ id: string }> {
  return dependencies.audit(tx, {
    entityType: "post",
    entityId: input.postId,
    action: input.action,
    actor: input.actor,
    before: pickPostPublishingAudit(input.before),
    after: pickPostPublishingAudit(input.after),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
  });
}

export async function schedulePost(
  postId: string,
  input: { scheduledAt: Date; actor: PublishingActor },
  dependencyOverrides: PublishingDependencyOverrides = {},
): Promise<Post> {
  const dependencies = resolvePublishingDependencies(dependencyOverrides);
  return getDb().transaction(async (tx) => {
    const now = await databaseNow(tx);
    assertFutureSchedule(input.scheduledAt, now);
    const before = await getPostForUpdate(tx, postId);
    if (derivePostState(before) !== "draft") {
      throw new ApiError(409, "postPublishingStale");
    }

    const scheduleToken = dependencies.createId();
    const correlationId = dependencies.createId();
    const [after] = await tx
      .update(posts)
      .set({
        scheduledAt: input.scheduledAt,
        scheduleToken,
        publishedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(posts.id, postId),
          eq(posts.status, "draft"),
          isNull(posts.scheduledAt),
          isNull(posts.scheduleToken),
        ),
      )
      .returning();
    if (!after) return throwPublishingStaleOrNotFound(tx, postId);

    const schedulingAudit = await writePostAudit(tx, dependencies, {
      postId,
      action: "post.scheduled",
      actor: input.actor,
      before,
      after,
      correlationId,
    });
    await dependencies.enqueue(tx, {
      kind: "publish_post",
      dedupeKey: `publish_post:${postId}:${scheduleToken}`,
      payload: {
        postId,
        scheduleToken,
        correlationId,
        schedulingAuditId: schedulingAudit.id,
      },
      runAfter: input.scheduledAt,
    });
    return after;
  });
}

export async function reschedulePost(
  postId: string,
  input: {
    scheduledAt: Date;
    expectedScheduleToken: string;
    actor: PublishingActor;
  },
  dependencyOverrides: PublishingDependencyOverrides = {},
): Promise<Post> {
  const dependencies = resolvePublishingDependencies(dependencyOverrides);
  return getDb().transaction(async (tx) => {
    const now = await databaseNow(tx);
    assertFutureSchedule(input.scheduledAt, now);
    const before = await getPostForUpdate(tx, postId);
    if (
      derivePostState(before) !== "scheduled" ||
      before.scheduleToken !== input.expectedScheduleToken
    ) {
      throw new ApiError(409, "postPublishingStale");
    }

    const scheduleToken = dependencies.createId();
    const correlationId = dependencies.createId();
    const [after] = await tx
      .update(posts)
      .set({ scheduledAt: input.scheduledAt, scheduleToken, updatedAt: now })
      .where(
        and(
          eq(posts.id, postId),
          eq(posts.status, "draft"),
          eq(posts.scheduleToken, input.expectedScheduleToken),
          isNotNull(posts.scheduledAt),
        ),
      )
      .returning();
    if (!after) return throwPublishingStaleOrNotFound(tx, postId);

    const schedulingAudit = await writePostAudit(tx, dependencies, {
      postId,
      action: "post.rescheduled",
      actor: input.actor,
      before,
      after,
      correlationId,
    });
    await dependencies.enqueue(tx, {
      kind: "publish_post",
      dedupeKey: `publish_post:${postId}:${scheduleToken}`,
      payload: {
        postId,
        scheduleToken,
        correlationId,
        schedulingAuditId: schedulingAudit.id,
      },
      runAfter: input.scheduledAt,
    });
    return after;
  });
}

export async function cancelPostSchedule(
  postId: string,
  input: { expectedScheduleToken: string; actor: PublishingActor },
  dependencyOverrides: PublishingDependencyOverrides = {},
): Promise<Post> {
  const dependencies = resolvePublishingDependencies(dependencyOverrides);
  return getDb().transaction(async (tx) => {
    const now = await databaseNow(tx);
    const before = await getPostForUpdate(tx, postId);
    if (
      derivePostState(before) !== "scheduled" ||
      before.scheduleToken !== input.expectedScheduleToken
    ) {
      throw new ApiError(409, "postPublishingStale");
    }

    const [after] = await tx
      .update(posts)
      .set({ scheduledAt: null, scheduleToken: null, updatedAt: now })
      .where(
        and(
          eq(posts.id, postId),
          eq(posts.status, "draft"),
          eq(posts.scheduleToken, input.expectedScheduleToken),
          isNotNull(posts.scheduledAt),
        ),
      )
      .returning();
    if (!after) return throwPublishingStaleOrNotFound(tx, postId);

    await writePostAudit(tx, dependencies, {
      postId,
      action: "post.schedule_cancelled",
      actor: input.actor,
      before,
      after,
      correlationId: dependencies.createId(),
    });
    return after;
  });
}

export async function publishPostNow(
  postId: string,
  input:
    | { expectedState: "draft"; actor: PublishingActor }
    | {
        expectedState: "scheduled";
        expectedScheduleToken: string;
        actor: PublishingActor;
      },
  dependencyOverrides: PublishingDependencyOverrides = {},
): Promise<Post> {
  const dependencies = resolvePublishingDependencies(dependencyOverrides);
  return getDb().transaction(async (tx) => {
    const now = await databaseNow(tx);
    const before = await getPostForUpdate(tx, postId);
    const expectedToken = input.expectedState === "scheduled" ? input.expectedScheduleToken : null;
    if (derivePostState(before) !== input.expectedState || before.scheduleToken !== expectedToken) {
      throw new ApiError(409, "postPublishingStale");
    }

    const sourceCondition =
      input.expectedState === "scheduled"
        ? and(eq(posts.scheduleToken, input.expectedScheduleToken), isNotNull(posts.scheduledAt))
        : and(isNull(posts.scheduleToken), isNull(posts.scheduledAt));
    const [after] = await tx
      .update(posts)
      .set({
        status: "published",
        publishedAt: now,
        scheduledAt: null,
        scheduleToken: null,
        updatedAt: now,
      })
      .where(and(eq(posts.id, postId), eq(posts.status, "draft"), sourceCondition))
      .returning();
    if (!after) return throwPublishingStaleOrNotFound(tx, postId);

    const correlationId = dependencies.createId();
    const audit = await writePostAudit(tx, dependencies, {
      postId,
      action: "post.published",
      actor: input.actor,
      before,
      after,
      correlationId,
    });
    await dependencies.createCampaign(tx, {
      post: after,
      before,
      after,
      source: "manual_publish",
      correlationId,
      causationId: audit.id,
    });
    return after;
  });
}

export async function archivePost(
  postId: string,
  input: { actor: PublishingActor },
  dependencyOverrides: PublishingDependencyOverrides = {},
): Promise<Post> {
  const dependencies = resolvePublishingDependencies(dependencyOverrides);
  return getDb().transaction(async (tx) => {
    const now = await databaseNow(tx);
    const before = await getPostForUpdate(tx, postId);
    if (derivePostState(before) !== "published") {
      throw new ApiError(409, "postPublishingStale");
    }

    const [after] = await tx
      .update(posts)
      .set({ status: "archived", scheduledAt: null, scheduleToken: null, updatedAt: now })
      .where(and(eq(posts.id, postId), eq(posts.status, "published")))
      .returning();
    if (!after) return throwPublishingStaleOrNotFound(tx, postId);

    await writePostAudit(tx, dependencies, {
      postId,
      action: "post.archived",
      actor: input.actor,
      before,
      after,
      correlationId: dependencies.createId(),
    });
    return after;
  });
}

export async function restorePost(
  postId: string,
  input: { actor: PublishingActor },
  dependencyOverrides: PublishingDependencyOverrides = {},
): Promise<Post> {
  const dependencies = resolvePublishingDependencies(dependencyOverrides);
  return getDb().transaction(async (tx) => {
    const now = await databaseNow(tx);
    const before = await getPostForUpdate(tx, postId);
    if (derivePostState(before) !== "archived") {
      throw new ApiError(409, "postPublishingStale");
    }

    const [after] = await tx
      .update(posts)
      .set({
        status: "draft",
        publishedAt: null,
        scheduledAt: null,
        scheduleToken: null,
        updatedAt: now,
      })
      .where(and(eq(posts.id, postId), eq(posts.status, "archived")))
      .returning();
    if (!after) return throwPublishingStaleOrNotFound(tx, postId);

    await writePostAudit(tx, dependencies, {
      postId,
      action: "post.restored",
      actor: input.actor,
      before,
      after,
      correlationId: dependencies.createId(),
    });
    return after;
  });
}

export async function executeScheduledPublish(
  input: {
    postId: string;
    scheduleToken: string;
    correlationId: string;
    schedulingAuditId: string;
  },
  dependencyOverrides: PublishingDependencyOverrides = {},
): Promise<ScheduledPublishResult> {
  const dependencies = resolvePublishingDependencies(dependencyOverrides);
  return getDb().transaction(async (tx) => {
    const now = await databaseNow(tx);
    const [before] = await tx
      .select()
      .from(posts)
      .where(eq(posts.id, input.postId))
      .limit(1)
      .for("update");
    if (!before) return { outcome: "noop", note: "Post no longer exists" };

    const [after] = await tx
      .update(posts)
      .set({
        status: "published",
        publishedAt: now,
        scheduledAt: null,
        scheduleToken: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(posts.id, input.postId),
          eq(posts.status, "draft"),
          eq(posts.scheduleToken, input.scheduleToken),
          lte(posts.scheduledAt, now),
        ),
      )
      .returning();

    if (!after) {
      const [current] = await tx.select().from(posts).where(eq(posts.id, input.postId)).limit(1);
      if (!current) return { outcome: "noop", note: "Post no longer exists" };
      if (
        current.status === "draft" &&
        current.scheduleToken === input.scheduleToken &&
        current.scheduledAt &&
        current.scheduledAt.getTime() > now.getTime()
      ) {
        return {
          outcome: "defer",
          note: "Scheduled publication is not due yet",
          deferUntil: current.scheduledAt,
        };
      }
      return { outcome: "noop", note: "Scheduled publication is stale" };
    }

    await writePostAudit(tx, dependencies, {
      postId: input.postId,
      action: "post.published",
      actor: { type: "system", id: null },
      before,
      after,
      correlationId: input.correlationId,
      causationId: input.schedulingAuditId,
    });
    await dependencies.createCampaign(tx, {
      post: after,
      before,
      after,
      source: "scheduled_publish",
      correlationId: input.correlationId,
      causationId: input.schedulingAuditId,
    });
    return { outcome: "published" };
  });
}
