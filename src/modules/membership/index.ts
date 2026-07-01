import { randomUUID } from "crypto";
import { and, asc, desc, eq, gt, gte, lte, max, ne, sql } from "drizzle-orm";

import { type DbClient, getDb, type TxClient } from "@/db";
import {
  type AuditEvent,
  auditEvents,
  type Membership,
  memberships,
  type MembershipTier,
  membershipTiers,
  users,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { addDays } from "@/lib/dates";
import {
  type AdminListPage,
  decodeAdminListCursor,
  encodeAdminListCursor,
  normalizeAdminPageSize,
} from "@/modules/admin/pagination";
import { pickMembershipAudit, recordAudit } from "@/modules/audit";
import { advanceManualReminderAfterGrant } from "@/modules/membership/renewal-reminders";

export type ActiveMembership = {
  membership: Membership;
  tier: MembershipTier;
};

export async function listTiers(opts?: { activeOnly?: boolean }): Promise<MembershipTier[]> {
  const db = getDb();
  const query = db.select().from(membershipTiers);
  const rows = opts?.activeOnly
    ? await query.where(eq(membershipTiers.isActive, true))
    : await query;
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.level - b.level);
}

export async function getTierById(
  id: string,
  dbc: DbClient = getDb(),
): Promise<MembershipTier | null> {
  const [tier] = await dbc
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.id, id))
    .limit(1);
  return tier ?? null;
}

/** 用户当前有效会员中 level 最高的一条。停售 tier 不影响已发放权益。 */
export async function getActiveMembership(
  userId: string,
  dbc: DbClient = getDb(),
): Promise<ActiveMembership | null> {
  const now = new Date();
  const rows = await dbc
    .select({ membership: memberships, tier: membershipTiers })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        lte(memberships.startsAt, now),
        gt(memberships.endsAt, now),
      ),
    )
    .orderBy(desc(membershipTiers.level), desc(memberships.endsAt));
  return rows[0] ?? null;
}

export async function getActiveLevel(userId: string): Promise<number> {
  const active = await getActiveMembership(userId);
  return active?.tier.level ?? 0;
}

export type LifecycleActor = { type: "admin"; id: string } | { type: "system"; id: null };
export type MembershipLifecycleAction = "suspend" | "resume" | "revoke" | "extend";
export type MembershipTransitionError = "alreadyInState" | "invalidMembershipTransition";

export type MembershipTransitionEvaluation =
  | { ok: true }
  | { ok: false; errorCode: MembershipTransitionError };

export function evaluateTransition(
  membership: Pick<Membership, "status" | "startsAt" | "endsAt">,
  action: MembershipLifecycleAction,
  now: Date,
): MembershipTransitionEvaluation {
  if (action === "extend") {
    if (membership.status === "revoked" || membership.endsAt <= now) {
      return { ok: false, errorCode: "invalidMembershipTransition" };
    }
    return { ok: true };
  }

  if (action === "suspend") {
    if (membership.status === "suspended") {
      return { ok: false, errorCode: "alreadyInState" };
    }
    return membership.status === "active"
      ? { ok: true }
      : { ok: false, errorCode: "invalidMembershipTransition" };
  }

  if (action === "resume") {
    if (membership.status === "active") {
      return { ok: false, errorCode: "alreadyInState" };
    }
    return membership.status === "suspended"
      ? { ok: true }
      : { ok: false, errorCode: "invalidMembershipTransition" };
  }

  if (membership.status === "revoked") {
    return { ok: false, errorCode: "alreadyInState" };
  }
  return { ok: true };
}

type LifecycleCommand = {
  actor: LifecycleActor;
  expectedVersion: number;
  correlationId?: string;
  causationId?: string | null;
};

type StateChangeCommand = LifecycleCommand & {
  reason: string;
};

type ExtendCommand = LifecycleCommand & {
  days: number;
};

type GrantMembershipInput = {
  userId: string;
  tierId: string;
  source: "manual" | "payment_review" | "payment_auto" | "gift" | "external";
  durationDays?: number;
  note?: string | null;
  createdBy?: string | null;
  actor?: LifecycleActor;
  correlationId?: string;
  causationId?: string | null;
};

type GrantMembershipForPeriodInput = {
  userId: string;
  tierId: string;
  source: "payment_auto";
  startsAt: Date;
  endsAt: Date;
  note?: string | null;
  createdBy?: string | null;
  actor?: LifecycleActor;
  correlationId?: string;
  causationId?: string | null;
};

/** Transaction-scoped lock for all membership grants for one user. */
export async function acquireUserGrantLock(tx: TxClient, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`membership-grant:${userId}`}, 0))`,
  );
}

async function getLatestGrantAnchor(
  tx: TxClient,
  userId: string,
  targetLevel: number,
  now: Date,
): Promise<Date> {
  const [row] = await tx
    .select({ latestEndsAt: max(memberships.endsAt) })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .where(
      and(
        eq(memberships.userId, userId),
        ne(memberships.status, "revoked"),
        gt(memberships.endsAt, now),
        gte(membershipTiers.level, targetLevel),
      ),
    );
  return row?.latestEndsAt && row.latestEndsAt > now ? row.latestEndsAt : now;
}

/**
 * 开通会员。
 * 同一用户的所有 grant 在显式事务中串行；同/高等级的 active、scheduled、suspended
 * 未结束权益都会作为顺延基准。低等级权益不阻止高等级立即生效。
 */
export async function grantMembership(
  input: GrantMembershipInput,
  dbc?: DbClient,
): Promise<{ membership: Membership; tier: MembershipTier }> {
  if (dbc && "rollback" in dbc) return grantMembershipTx(input, dbc as TxClient);
  const db = dbc && "transaction" in dbc ? dbc : getDb();
  return db.transaction((tx) => grantMembershipTx(input, tx));
}

async function grantMembershipTx(
  input: GrantMembershipInput,
  tx: TxClient,
): Promise<{ membership: Membership; tier: MembershipTier }> {
  await acquireUserGrantLock(tx, input.userId);

  const tier = await getTierById(input.tierId, tx);
  if (!tier) throw new ApiError(404, "tierNotFound");

  const duration = input.durationDays ?? tier.durationDays;
  const now = new Date();
  const startsAt = await getLatestGrantAnchor(tx, input.userId, tier.level, now);
  const endsAt = addDays(startsAt, duration);

  const [membership] = await tx
    .insert(memberships)
    .values({
      userId: input.userId,
      tierId: input.tierId,
      source: input.source,
      startsAt,
      endsAt,
      note: input.note ?? null,
      status: "active",
      createdBy: input.createdBy ?? null,
    })
    .returning();

  const actor =
    input.actor ??
    (input.createdBy
      ? ({ type: "admin", id: input.createdBy } as const)
      : ({ type: "system", id: null } as const));
  await recordAudit(tx, {
    entityType: "membership",
    entityId: membership.id,
    action: "grant",
    actor,
    after: pickMembershipAudit(membership),
    correlationId: input.correlationId ?? randomUUID(),
    causationId: input.causationId ?? null,
  });

  await advanceManualReminderAfterGrant(tx, {
    userId: input.userId,
    tierId: input.tierId,
    targetLevel: tier.level,
  });

  return { membership, tier };
}

/**
 * 开通指定周期的会员。
 * 订阅续费必须逐字写入 Stripe invoice period，不以 now/current 重新锚定。
 */
export async function grantMembershipForPeriod(
  input: GrantMembershipForPeriodInput,
  tx: TxClient,
): Promise<{ membership: Membership; tier: MembershipTier }> {
  await acquireUserGrantLock(tx, input.userId);

  if (input.endsAt <= input.startsAt) throw new ApiError(400, "invalidMembershipPeriod");

  const tier = await getTierById(input.tierId, tx);
  if (!tier) throw new ApiError(404, "tierNotFound");

  const [membership] = await tx
    .insert(memberships)
    .values({
      userId: input.userId,
      tierId: input.tierId,
      source: input.source,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      note: input.note ?? null,
      status: "active",
      createdBy: input.createdBy ?? null,
    })
    .returning();

  const actor =
    input.actor ??
    (input.createdBy
      ? ({ type: "admin", id: input.createdBy } as const)
      : ({ type: "system", id: null } as const));
  await recordAudit(tx, {
    entityType: "membership",
    entityId: membership.id,
    action: "grant",
    actor,
    after: pickMembershipAudit(membership),
    correlationId: input.correlationId ?? randomUUID(),
    causationId: input.causationId ?? null,
  });

  return { membership, tier };
}

export async function suspendMembership(
  id: string,
  command: StateChangeCommand,
): Promise<Membership> {
  return changeMembership(id, "suspend", command);
}

export async function resumeMembership(
  id: string,
  command: StateChangeCommand,
): Promise<Membership> {
  return changeMembership(id, "resume", command);
}

export async function revokeMembership(
  id: string,
  command: StateChangeCommand,
  dbc?: DbClient,
): Promise<Membership> {
  return changeMembership(id, "revoke", command, dbc);
}

export async function extendMembership(id: string, command: ExtendCommand): Promise<Membership> {
  if (!Number.isInteger(command.days) || command.days <= 0) {
    throw new ApiError(400, "invalidMembershipExtension");
  }
  return changeMembership(id, "extend", command);
}

async function changeMembership(
  id: string,
  action: MembershipLifecycleAction,
  command: StateChangeCommand | ExtendCommand,
  dbc?: DbClient,
): Promise<Membership> {
  const now = new Date();
  const reason = "reason" in command ? command.reason.trim() : null;
  if ("reason" in command && !reason) {
    throw new ApiError(400, "membershipReasonRequired");
  }

  if (dbc) {
    return changeMembershipWithClient(dbc, id, action, command, now, reason);
  }
  return getDb().transaction((tx) =>
    changeMembershipWithClient(tx, id, action, command, now, reason),
  );
}

async function changeMembershipWithClient(
  tx: DbClient,
  id: string,
  action: MembershipLifecycleAction,
  command: StateChangeCommand | ExtendCommand,
  now: Date,
  reason: string | null,
): Promise<Membership> {
  const before = await getMembershipById(id, tx);
  if (!before) throw new ApiError(404, "membershipNotFound");
  if (before.version !== command.expectedVersion) {
    throw new ApiError(409, "membershipStale");
  }
  const evaluation = evaluateTransition(before, action, now);
  if (!evaluation.ok) throw new ApiError(409, evaluation.errorCode);

  const status =
    action === "suspend"
      ? "suspended"
      : action === "resume"
        ? "active"
        : action === "revoke"
          ? "revoked"
          : before.status;
  const endsAt =
    action === "extend" ? addDays(before.endsAt, (command as ExtendCommand).days) : before.endsAt;
  const allowedStatus =
    action === "suspend"
      ? "active"
      : action === "resume"
        ? "suspended"
        : action === "revoke"
          ? before.status
          : before.status;

  const conditions = [
    eq(memberships.id, id),
    eq(memberships.version, command.expectedVersion),
    eq(memberships.status, allowedStatus),
  ];
  if (action === "extend") conditions.push(gt(memberships.endsAt, now));

  const [updated] = await tx
    .update(memberships)
    .set({
      status,
      endsAt,
      version: sql`${memberships.version} + 1`,
      updatedAt: now,
    })
    .where(and(...conditions))
    .returning();

  if (!updated) {
    await throwTransitionFailure(tx, id, command.expectedVersion, action, now);
  }

  await recordAudit(tx, {
    entityType: "membership",
    entityId: id,
    action,
    actor: command.actor,
    reason,
    before: pickMembershipAudit(before),
    after: pickMembershipAudit(updated),
    correlationId: command.correlationId ?? randomUUID(),
    causationId: command.causationId ?? null,
  });
  return updated;
}

async function getMembershipById(id: string, dbc: DbClient): Promise<Membership | null> {
  const [membership] = await dbc.select().from(memberships).where(eq(memberships.id, id)).limit(1);
  return membership ?? null;
}

async function throwTransitionFailure(
  tx: DbClient,
  id: string,
  expectedVersion: number,
  action: MembershipLifecycleAction,
  now: Date,
): Promise<never> {
  const current = await getMembershipById(id, tx);
  if (!current) throw new ApiError(404, "membershipNotFound");
  if (current.version !== expectedVersion) {
    throw new ApiError(409, "membershipStale");
  }
  const evaluation = evaluateTransition(current, action, now);
  throw new ApiError(409, evaluation.ok ? "invalidMembershipTransition" : evaluation.errorCode);
}

export type MembershipListItem = {
  membership: Membership;
  tier: MembershipTier;
  userEmail: string;
};

export async function listMembershipsPage(
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<AdminListPage<MembershipListItem>> {
  const limit = normalizeAdminPageSize(opts.limit);
  const cursor = decodeAdminListCursor(opts.cursor);
  const cursorCreatedAt = sql<string>`to_char(
    ${memberships.createdAt} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`;
  const rows = await getDb()
    .select({
      membership: memberships,
      tier: membershipTiers,
      userEmail: users.email,
      cursorCreatedAt,
    })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(
      cursor
        ? sql`(${memberships.createdAt}, ${memberships.id}) <
            (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`
        : undefined,
    )
    .orderBy(desc(memberships.createdAt), desc(memberships.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(({ cursorCreatedAt, ...item }) => {
    void cursorCreatedAt;
    return item;
  });
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeAdminListCursor({ timestamp: last.cursorCreatedAt, id: last.membership.id })
        : null,
  };
}

export async function getMembershipDetail(
  id: string,
  dbc: DbClient = getDb(),
): Promise<{
  membership: Membership;
  tier: MembershipTier;
  userEmail: string;
} | null> {
  const [detail] = await dbc
    .select({ membership: memberships, tier: membershipTiers, userEmail: users.email })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.id, id))
    .limit(1);
  return detail ?? null;
}

export async function listMembershipHistory(
  id: string,
  dbc: DbClient = getDb(),
): Promise<AuditEvent[]> {
  return dbc
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "membership"), eq(auditEvents.entityId, id)))
    .orderBy(desc(auditEvents.createdAt));
}

export async function listTiersOrdered(): Promise<MembershipTier[]> {
  return getDb()
    .select()
    .from(membershipTiers)
    .orderBy(asc(membershipTiers.sortOrder), asc(membershipTiers.level));
}
