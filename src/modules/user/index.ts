import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import type { Locale } from "@/modules/i18n";

export async function findUserByEmail(email: string): Promise<User | null> {
  const [user] = await getDb()
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

export async function findOrCreateUserByEmail(email: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const existing = await findUserByEmail(normalized);
  if (existing) return existing;
  const [created] = await getDb()
    .insert(users)
    .values({ email: normalized, role: "member" })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (created) return created;
  const after = await findUserByEmail(normalized);
  if (!after) throw new ApiError(500, "userCreateFailed");
  return after;
}

export async function touchLastLogin(userId: string, locale?: Locale): Promise<void> {
  await getDb()
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date(), ...(locale ? { locale } : {}) })
    .where(eq(users.id, userId));
}

export async function updateUserLocale(userId: string, locale: Locale): Promise<void> {
  await getDb().update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function listUsers(): Promise<User[]> {
  return getDb().select().from(users).orderBy(desc(users.createdAt));
}
