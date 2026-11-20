import { randomBytes, randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { readerInvitations, type User } from "@/db/schema";
import { hmacSha256WithPurpose } from "@/lib/crypto";
import { recordAudit } from "@/modules/audit";
import { normalizedEmailSchema, normalizeEmail } from "@/modules/auth/input-policy";

const invitationHash = (token: string) => hmacSha256WithPurpose("reader-invitation", token);

export async function createReaderInvitation(email: string, adminId: string): Promise<string> {
  const recipient = normalizedEmailSchema.parse(normalizeEmail(email));
  const token = randomBytes(32).toString("base64url");
  await getDb().transaction(async (tx) => {
    const [invitation] = await tx
      .insert(readerInvitations)
      .values({
        email: recipient,
        tokenHash: invitationHash(token),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning({ id: readerInvitations.id });
    await recordAudit(tx, {
      entityType: "reader_invitation",
      entityId: invitation.id,
      action: "reader_invitation_created",
      actor: { type: "admin", id: adminId },
      correlationId: randomUUID(),
    });
  });
  return token;
}

export function isReaderInvitationToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function redeemReaderInvitation(token: string, user: User): Promise<boolean> {
  if (!isReaderInvitationToken(token)) return false;
  return getDb().transaction(async (tx) => {
    const [invitation] = await tx
      .update(readerInvitations)
      .set({ redeemedAt: sql`clock_timestamp()`, redeemedBy: user.id })
      .where(
        and(
          eq(readerInvitations.tokenHash, invitationHash(token)),
          eq(readerInvitations.email, normalizeEmail(user.email)),
          gt(readerInvitations.expiresAt, sql`clock_timestamp()`),
          isNull(readerInvitations.redeemedAt),
          isNull(readerInvitations.revokedAt),
        ),
      )
      .returning({ id: readerInvitations.id });
    if (!invitation) return false;
    await recordAudit(tx, {
      entityType: "reader_invitation",
      entityId: invitation.id,
      action: "reader_invitation_redeemed",
      actor: { type: "user", id: user.id },
      correlationId: randomUUID(),
    });
    return true;
  });
}

export async function revokeReaderInvitation(id: string, adminId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [revoked] = await tx
      .update(readerInvitations)
      .set({ revokedAt: sql`clock_timestamp()` })
      .where(and(eq(readerInvitations.id, id), isNull(readerInvitations.revokedAt)))
      .returning({ id: readerInvitations.id });
    if (!revoked) return;
    await recordAudit(tx, {
      entityType: "reader_invitation",
      entityId: id,
      action: "reader_invitation_revoked",
      actor: { type: "admin", id: adminId },
      correlationId: randomUUID(),
    });
  });
}

export async function listReaderInvitations(email: string, page: number) {
  const size = 50;
  const records = await getDb()
    .select({
      id: readerInvitations.id,
      email: readerInvitations.email,
      expiresAt: readerInvitations.expiresAt,
      redeemedAt: readerInvitations.redeemedAt,
      revokedAt: readerInvitations.revokedAt,
    })
    .from(readerInvitations)
    .where(email ? eq(readerInvitations.email, normalizeEmail(email)) : undefined)
    .orderBy(desc(readerInvitations.createdAt), desc(readerInvitations.id))
    .limit(size + 1)
    .offset((page - 1) * size);
  return { items: records.slice(0, size), hasNext: records.length > size };
}
