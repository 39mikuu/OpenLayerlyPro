import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { verifyPassword } from "@/lib/crypto";
import { recordEvent } from "@/modules/system/events";
import { touchLastLogin } from "@/modules/user";

// A valid cost-12 bcrypt digest used only to equalize the missing/ineligible
// account path. Keeping it static avoids doing an extra hash on every request.
const INVALID_ADMIN_PASSWORD_HASH = "$2b$12$fJELB8lCKlFyw5qRE8W49uYzOHdQ2uz53DmFwjBZk7d0RES240//y";

export async function adminLogin(email: string, password: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const [user] = await getDb().select().from(users).where(eq(users.email, normalized)).limit(1);

  const passwordHash =
    user?.role === "admin" && user.passwordHash ? user.passwordHash : INVALID_ADMIN_PASSWORD_HASH;
  const valid = await verifyPassword(password, passwordHash);
  if (!user || user.role !== "admin" || !user.passwordHash || !valid) {
    throw new ApiError(401, "invalidCredentials");
  }
  await touchLastLogin(user.id);
  await recordEvent("admin_login", { userId: user.id });
  return user;
}
