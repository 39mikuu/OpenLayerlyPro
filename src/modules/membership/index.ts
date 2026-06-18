import { randomUUID } from "crypto";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import {
  type Membership,
  memberships,
  type MembershipTier,
  membershipTiers,
  users,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { addDays } from "@/lib/dates";
import { pickMembershipAudit, recordAudit } from "@/modules/audit";

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
  source: "manual" | "payment_review" | "gift" | "external";
  durationDays?: number;
  note?: string | null;
  createdBy?: string | null;
  actor?: LifecycleActor;
  correlationId?: string;
  causationId?: string | null;
};

/**
 * 开通会员。
 * 若用户已有同等级或更高等级的有效会员，新会员从现有会员到期时间顺延开始（PRD §12.6）。
 * 低等级有效会员不影响：直接从现在开始创建新的高等级会员。
 */
export async function grantMembership(
  input: GrantMembershipInput,
  dbc?: DbClient,
): Promise<{ membership: Membership; tier: MembershipTier }> {
  if (dbc) return grantMembershipWithClient(input, dbc);
  return getDb().transaction((tx) => grantMembershipWithClient(input, tx));
}

async function grantMembershipWithClient(
  input: GrantMembershipInput,
  dbc: DbClient,
): Promise<{ membership: Membership; tier: MembershipTier }> {
  const tier = await getTierById(input.tierId, dbc);
  if (!tier) throw new ApiError(404, "tierNotFound");

  const duration = input.durationDays ?? tier.durationDays;
  const now = new Date();

  const current = await getActiveMembership(input.userId, dbc);
  const startsAt =
    current && current.tier.level >= tier.level && current.membership.endsAt > now
      ? current.membership.endsAt
      : now;
  const endsAt = addDays(startsAt, duration);

  const [membership] = await dbc
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
  await recordAudit(dbc, {
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

export async function listMemberships(): Promise<
  { membership: Membership; tier: MembershipTier; userEmail: string }[]
> {
  const rows = await getDb()
    .select({ membership: memberships, tier: membershipTiers, userEmail: users.email })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .innerJoin(users, eq(memberships.userId, users.id))
    .orderBy(desc(memberships.createdAt));
  return rows;
}

export async function updateMembership(
  id: string,
  patch: { startsAt?: Date; endsAt?: Date; note?: string | null },
): Promise<Membership> {
  const [updated] = await getDb()
    .update(memberships)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(memberships.id, id))
    .returning();
  if (!updated) throw new ApiError(404, "membershipNotFound");
  return updated;
}

export async function deleteMembership(id: string): Promise<void> {
  await getDb().delete(memberships).where(eq(memberships.id, id));
}

export async function listTiersOrdered(): Promise<MembershipTier[]> {
  return getDb()
    .select()
    .from(membershipTiers)
    .orderBy(asc(membershipTiers.sortOrder), asc(membershipTiers.level));
}
