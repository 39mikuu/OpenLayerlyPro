import { desc, eq } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
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

export async function listUsers(): Promise<User[]> {
  return getDb().select().from(users).orderBy(desc(users.createdAt));
}
