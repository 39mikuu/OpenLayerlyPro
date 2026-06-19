import { randomUUID } from "crypto";
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";

import { getDb } from "@/db";
import { type AuditEvent, auditEvents, sessions, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { recordAudit } from "@/modules/audit";

const MIN_PASSWORD_LENGTH = 8;
const ADMIN_AUDIT_ACTIONS = [
  "password_changed",
  "email_changed",
  "session_revoked",
  "sessions_revoked_all",
  "account_recovered",
] as const;

export type AdminSessionView = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, "passwordTooShort", { min: MIN_PASSWORD_LENGTH });
  }
}

async function requirePassword(userId: string, currentPassword: string) {
  const [user] = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.role, "admin")))
    .limit(1);
  if (!user?.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ApiError(401, "invalidCredentials");
  }
  return user;
}

export async function listMySessions(
  userId: string,
  currentTokenHash: string,
): Promise<AdminSessionView[]> {
  const rows = await getDb()
    .select({
      id: sessions.id,
      tokenHash: sessions.tokenHash,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.createdAt));
  return rows.map(({ tokenHash, ...session }) => ({
    ...session,
    current: tokenHash === currentTokenHash,
  }));
}

export async function revokeSession(
  userId: string,
  sessionId: string,
  currentTokenHash: string,
): Promise<{ current: boolean }> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .limit(1)
      .for("update");
    if (!session) throw new ApiError(404, "sessionNotFound");

    await tx.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
    await recordAudit(tx, {
      entityType: "admin",
      entityId: userId,
      action: "session_revoked",
      actor: { type: "admin", id: userId },
      before: {
        sessionId: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      },
      after: { revoked: true },
      correlationId: randomUUID(),
    });
    return { current: session.tokenHash === currentTokenHash };
  });
}

export async function revokeOtherSessions(
  userId: string,
  currentTokenHash: string,
): Promise<number> {
  return getDb().transaction(async (tx) => {
    const deleted = await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, currentTokenHash)))
      .returning({ id: sessions.id });
    await recordAudit(tx, {
      entityType: "admin",
      entityId: userId,
      action: "sessions_revoked_all",
      actor: { type: "admin", id: userId },
      before: null,
      after: { revokedCount: deleted.length },
      correlationId: randomUUID(),
    });
    return deleted.length;
  });
}

export async function changeAdminPassword(
  userId: string,
  input: { currentPassword: string; newPassword: string; currentTokenHash: string },
): Promise<{ revokedSessions: number }> {
  assertPasswordStrength(input.newPassword);
  const user = await requirePassword(userId, input.currentPassword);
  const passwordHash = await hashPassword(input.newPassword);

  return getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.passwordHash, user.passwordHash!)))
      .returning({ id: users.id });
    if (!updated) throw new ApiError(409, "adminAccountChanged");

    const deleted = await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, input.currentTokenHash)))
      .returning({ id: sessions.id });
    await recordAudit(tx, {
      entityType: "admin",
      entityId: userId,
      action: "password_changed",
      actor: { type: "admin", id: userId },
      before: null,
      after: { otherSessionsRevoked: deleted.length },
      correlationId: randomUUID(),
    });
    return { revokedSessions: deleted.length };
  });
}

export async function changeAdminEmail(
  userId: string,
  input: { currentPassword: string; newEmail: string },
): Promise<{ email: string }> {
  const user = await requirePassword(userId, input.currentPassword);
  const email = normalizeEmail(input.newEmail);
  if (email === user.email) return { email };

  try {
    return await getDb().transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (existing && existing.id !== userId) throw new ApiError(409, "emailTaken");

      const [updated] = await tx
        .update(users)
        .set({ email, updatedAt: new Date() })
        .where(
          and(
            eq(users.id, userId),
            eq(users.email, user.email),
            eq(users.passwordHash, user.passwordHash!),
          ),
        )
        .returning({ email: users.email });
      if (!updated) throw new ApiError(409, "adminAccountChanged");
      await recordAudit(tx, {
        entityType: "admin",
        entityId: userId,
        action: "email_changed",
        actor: { type: "admin", id: userId },
        before: { email: user.email },
        after: { email: updated.email },
        correlationId: randomUUID(),
      });
      return updated;
    });
  } catch (error) {
    if (
      error instanceof ApiError ||
      !(typeof error === "object" && error !== null && "code" in error && error.code === "23505")
    ) {
      throw error;
    }
    throw new ApiError(409, "emailTaken");
  }
}

export async function listAdminAuditHistory(userId: string, limit = 100): Promise<AuditEvent[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  return getDb()
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, "admin"),
        eq(auditEvents.entityId, userId),
        inArray(auditEvents.action, ADMIN_AUDIT_ACTIONS),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(safeLimit);
}
