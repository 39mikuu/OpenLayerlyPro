import { and, desc, eq, gt, lte, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { memberships, membershipTiers, type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import {
  type AdminListPage,
  decodeAdminListCursor,
  encodeAdminListCursor,
  normalizeAdminPageSize,
} from "@/modules/admin/pagination";
import type { Locale } from "@/modules/i18n";

export async function findUserByEmail(
  email: string,
  client: DbClient = getDb(),
): Promise<User | null> {
  const [user] = await client
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return user ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const [user] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

export async function findOrCreateUserByEmail(
  email: string,
  client: DbClient = getDb(),
): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const existing = await findUserByEmail(normalized, client);
  if (existing) return existing;
  const [created] = await client
    .insert(users)
    .values({ email: normalized, role: "member" })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (created) return created;
  const after = await findUserByEmail(normalized, client);
  if (!after) throw new ApiError(500, "userCreateFailed");
  return after;
}

export async function touchLastLogin(
  userId: string,
  locale?: Locale,
  client: DbClient = getDb(),
): Promise<void> {
  await client
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date(), ...(locale ? { locale } : {}) })
    .where(eq(users.id, userId));
}

export async function updateUserLocale(userId: string, locale: Locale): Promise<void> {
  await getDb().update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function updateUserDisplayName(
  userId: string,
  displayName: string | null,
): Promise<void> {
  await getDb()
    .update(users)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export type AdminUserListItem = {
  user: Pick<User, "id" | "email" | "role" | "createdAt" | "lastLoginAt">;
  activeMembership: {
    id: string;
    tierName: string;
    endsAt: Date;
  } | null;
};

export async function listUsersPage(
  opts: { cursor?: string | null; limit?: number } = {},
  dbc: DbClient = getDb(),
): Promise<AdminListPage<AdminUserListItem>> {
  const limit = normalizeAdminPageSize(opts.limit);
  const cursor = decodeAdminListCursor(opts.cursor, "users");
  const now = new Date();
  const activeMembership = dbc
    .select({
      id: memberships.id,
      tierName: membershipTiers.name,
      endsAt: memberships.endsAt,
    })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .where(
      and(
        eq(memberships.userId, users.id),
        eq(memberships.status, "active"),
        lte(memberships.startsAt, now),
        gt(memberships.endsAt, now),
      ),
    )
    .orderBy(desc(membershipTiers.level), desc(memberships.endsAt), desc(memberships.id))
    .limit(1)
    .as("active_membership");
  const cursorCreatedAt = sql<string>`to_char(
    ${users.createdAt} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`;
  const rows = await dbc
    .select({
      user: {
        id: users.id,
        email: users.email,
        role: users.role,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      },
      activeMembership: {
        id: activeMembership.id,
        tierName: activeMembership.tierName,
        endsAt: activeMembership.endsAt,
      },
      cursorCreatedAt,
    })
    .from(users)
    .leftJoinLateral(activeMembership, sql`true`)
    .where(
      cursor
        ? sql`(${users.createdAt}, ${users.id}) <
            (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`
        : undefined,
    )
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);

  return {
    items: pageRows.map(({ user, activeMembership: active }) => ({
      user,
      activeMembership: active?.id ? active : null,
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeAdminListCursor({
            version: 1,
            scope: "users",
            timestamp: last.cursorCreatedAt,
            id: last.user.id,
          })
        : null,
  };
}
