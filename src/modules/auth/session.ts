import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";

import { getDb } from "@/db";
import { sessions, type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { generateSessionToken, hmacSha256 } from "@/lib/crypto";
import { addDays } from "@/lib/dates";
import { isProduction } from "@/lib/env";

export const SESSION_COOKIE = "ams_session";
const SESSION_DAYS = 30;

export async function createSession(
  userId: string,
  meta?: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = addDays(new Date(), SESSION_DAYS);
  await getDb()
    .insert(sessions)
    .values({
      userId,
      tokenHash: hmacSha256(token),
      expiresAt,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, path: "/" });
}

export async function getCurrentSessionTokenHash(): Promise<string> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) throw new ApiError(401, "authRequired");
  return hmacSha256(token);
}

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await getDb()
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hmacSha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.user ?? null;
});

export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await getDb()
      .delete(sessions)
      .where(eq(sessions.tokenHash, hmacSha256(token)));
  }
  await clearSessionCookie();
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "authRequired");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") throw new ApiError(403, "adminRequired");
  return user;
}

export async function requireAdminSession(): Promise<{ user: User; tokenHash: string }> {
  const user = await requireAdmin();
  return { user, tokenHash: await getCurrentSessionTokenHash() };
}
