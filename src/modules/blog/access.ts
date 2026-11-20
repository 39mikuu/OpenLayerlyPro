import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { cache } from "react";

import { type DbClient, getDb } from "@/db";
import { readerInvitations, type User } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";

export async function hasInvitationGrant(
  userId: string,
  database: DbClient = getDb(),
): Promise<boolean> {
  const [grant] = await database
    .select({ id: readerInvitations.id })
    .from(readerInvitations)
    .where(and(eq(readerInvitations.redeemedBy, userId), isNull(readerInvitations.revokedAt)))
    .limit(1);
  return Boolean(grant);
}

const readInvitationGrant = cache((userId: string) => hasInvitationGrant(userId));

export async function canEnterInside(user: User | null): Promise<boolean> {
  if (!user) return false;
  if (user.role === "admin") return true;
  return readInvitationGrant(user.id);
}

export async function requireBlogReaderAccess(user: User): Promise<User> {
  if (getEnv().PERSONAL_BLOG_MODE && !(await canEnterInside(user))) {
    throw new ApiError(403, "accessDenied");
  }
  return user;
}

export async function mayCreateReaderAccount(email: string, database: DbClient): Promise<boolean> {
  if (!getEnv().PERSONAL_BLOG_MODE) return true;
  const [invite] = await database
    .select({ id: readerInvitations.id })
    .from(readerInvitations)
    .where(
      and(
        eq(readerInvitations.email, email),
        isNull(readerInvitations.redeemedAt),
        isNull(readerInvitations.revokedAt),
        gt(readerInvitations.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .limit(1);
  return Boolean(invite);
}
