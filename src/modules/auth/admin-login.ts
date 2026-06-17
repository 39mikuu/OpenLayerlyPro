import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { verifyPassword } from "@/lib/crypto";
import { recordEvent } from "@/modules/system/events";
import { touchLastLogin } from "@/modules/user";

export async function adminLogin(email: string, password: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const [user] = await getDb().select().from(users).where(eq(users.email, normalized)).limit(1);

  if (!user || user.role !== "admin" || !user.passwordHash) {
    throw new ApiError(401, "invalidCredentials");
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new ApiError(401, "invalidCredentials");
  }
  await touchLastLogin(user.id);
  await recordEvent("admin_login", { userId: user.id });
  return user;
}
