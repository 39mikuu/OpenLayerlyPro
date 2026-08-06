import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  magicLinkMintLedger,
  magicLinkRequests,
  magicLinkTokens,
  sessions,
  tasks,
  users,
} from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/crypto";

import {
  changeAdminEmail,
  changeAdminPassword,
  listAdminAuditHistory,
  listMySessions,
  revokeOtherSessions,
  revokeSession,
} from "./admin-account";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("administrator account maintenance integration", () => {
  const db = getDb();

  async function seedAdmin(password = "current-password") {
    const [admin] = await db
      .insert(users)
      .values({
        email: `admin-${randomUUID()}@example.com`,
        role: "admin",
        passwordHash: await hashPassword(password),
      })
      .returning();
    const currentTokenHash = `current-${randomUUID()}`;
    const otherTokenHash = `other-${randomUUID()}`;
    const created = await db
      .insert(sessions)
      .values([
        {
          userId: admin.id,
          tokenHash: currentTokenHash,
          expiresAt: new Date(Date.now() + 60_000),
          ip: "127.0.0.1",
          userAgent: "current browser",
        },
        {
          userId: admin.id,
          tokenHash: otherTokenHash,
          expiresAt: new Date(Date.now() + 60_000),
          ip: "192.0.2.1",
          userAgent: "other browser",
        },
      ])
      .returning();
    return { admin, currentTokenHash, otherTokenHash, sessions: created };
  }

  async function attachV2MintLedger(input: { candidateId: string; email: string }) {
    const mintedAt = new Date();
    const [request] = await db
      .insert(magicLinkRequests)
      .values({
        email: input.email,
        resolvedAt: mintedAt,
        mintedAt,
        mintedTokenId: input.candidateId,
      })
      .returning();
    const [deliveryTask] = await db
      .insert(tasks)
      .values({
        kind: "auth.magic_link_email",
        dedupeKey: `admin-account-fixture:${input.candidateId}`,
        payloadJson: {
          version: 1,
          deliveryProtocol: 2,
          tokenId: input.candidateId,
          encryptedToken: "fixture-encrypted-token",
        },
        queueClass: "auth_delivery_v2",
        status: "pending",
      })
      .returning();
    await db.insert(magicLinkMintLedger).values({
      requestId: request!.id,
      mintedTokenId: input.candidateId,
      deliveryTaskId: deliveryTask!.id,
      mintedAt,
    });
  }

  it("changes the password, preserves the current session, revokes others, and audits safely", async () => {
    const { admin, currentTokenHash } = await seedAdmin();

    await expect(
      changeAdminPassword(admin.id, {
        currentPassword: "wrong-password",
        newPassword: "new-secure-password",
        currentTokenHash,
      }),
    ).rejects.toMatchObject({ status: 401, code: "invalidCredentials" });

    const result = await changeAdminPassword(admin.id, {
      currentPassword: "current-password",
      newPassword: "new-secure-password",
      currentTokenHash,
    });
    expect(result.revokedSessions).toBe(1);

    const [storedUser] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(await verifyPassword("new-secure-password", storedUser!.passwordHash!)).toBe(true);
    const storedSessions = await db.select().from(sessions).where(eq(sessions.userId, admin.id));
    expect(storedSessions).toHaveLength(1);
    expect(storedSessions[0]?.tokenHash).toBe(currentTokenHash);

    const history = await listAdminAuditHistory(admin.id);
    expect(history[0]).toMatchObject({
      action: "password_changed",
      actorType: "admin",
      entityId: admin.id,
    });
    expect(JSON.stringify(history[0])).not.toContain(storedUser!.passwordHash!);
    expect(JSON.stringify(history[0])).not.toContain("current-password");
    expect(JSON.stringify(history[0])).not.toContain("new-secure-password");
  });

  it("lists only active own sessions and supports revoking one or all other sessions", async () => {
    const { admin, currentTokenHash, sessions: created } = await seedAdmin();
    await db.insert(sessions).values({
      userId: admin.id,
      tokenHash: `expired-${randomUUID()}`,
      expiresAt: new Date(Date.now() - 1_000),
    });
    const [otherAdmin] = await db
      .insert(users)
      .values({ email: `other-${randomUUID()}@example.com`, role: "admin" })
      .returning();
    const [foreignSession] = await db
      .insert(sessions)
      .values({
        userId: otherAdmin.id,
        tokenHash: `foreign-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    const listed = await listMySessions(admin.id, currentTokenHash);
    expect(listed).toHaveLength(2);
    expect(listed.filter((session) => session.current)).toHaveLength(1);

    await expect(
      revokeSession(admin.id, foreignSession.id, currentTokenHash),
    ).rejects.toMatchObject({ status: 404, code: "sessionNotFound" });
    await expect(revokeSession(admin.id, created[1]!.id, currentTokenHash)).resolves.toEqual({
      current: false,
    });
    // The expired row is hidden from the session list but is still cleaned up by revoke-all.
    expect(await revokeOtherSessions(admin.id, currentTokenHash)).toBe(1);

    const remaining = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, admin.id), eq(sessions.tokenHash, currentTokenHash)));
    expect(remaining).toHaveLength(1);
    const actions = (await listAdminAuditHistory(admin.id)).map((event) => event.action);
    expect(actions).toContain("session_revoked");
    expect(actions).toContain("sessions_revoked_all");
  });

  it("changes email after re-authentication and rejects an existing address", async () => {
    const { admin } = await seedAdmin();
    const takenEmail = `taken-${randomUUID()}@example.com`;
    await db.insert(users).values({ email: takenEmail });

    await expect(
      changeAdminEmail(admin.id, {
        currentPassword: "current-password",
        newEmail: takenEmail,
      }),
    ).rejects.toMatchObject({ status: 409, code: "emailTaken" });

    const newEmail = `renamed-${randomUUID()}@example.com`;
    await expect(
      changeAdminEmail(admin.id, {
        currentPassword: "current-password",
        newEmail: `  ${newEmail.toUpperCase()}  `,
      }),
    ).resolves.toEqual({ email: newEmail });
    const [stored] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(stored?.email).toBe(newEmail);
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, admin.id), eq(auditEvents.action, "email_changed")));
    expect(event).toMatchObject({
      beforeJson: { email: admin.email },
      afterJson: { email: newEmail },
    });
  });

  it("does not promote an address while a Magic Link SMTP reservation is fenced", async () => {
    const { admin } = await seedAdmin();
    const newEmail = `fenced-${randomUUID()}@example.test`;
    const reservationId = randomUUID();
    const [candidate] = await db
      .insert(magicLinkTokens)
      .values({
        email: newEmail,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(0),
        deliveryState: "pending",
        deliveredAt: null,
        deliveryReservationId: reservationId,
        deliveryReservationUntil: new Date(Date.now() - 60_000),
      })
      .returning();
    await attachV2MintLedger({ candidateId: candidate!.id, email: newEmail });

    await expect(
      changeAdminEmail(admin.id, {
        currentPassword: "current-password",
        newEmail,
      }),
    ).rejects.toMatchObject({ status: 409, code: "magicLinkDeliveryInFlight" });
    const [unchanged] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(unchanged?.email).toBe(admin.email);
    const actions = (await listAdminAuditHistory(admin.id)).map((event) => event.action);
    expect(actions).toContain("magic_link_promotion_blocked");

    await db
      .update(magicLinkTokens)
      .set({ deliveryReservationId: null, deliveryReservationUntil: null })
      .where(eq(magicLinkTokens.id, candidate.id));
    await expect(
      changeAdminEmail(admin.id, {
        currentPassword: "current-password",
        newEmail,
      }),
    ).resolves.toEqual({ email: newEmail });
    const [cancelled] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, candidate.id));
    expect(cancelled).toMatchObject({ deliveryState: "cancelled" });
  });

  it("documents the exact-base change-admin write as a mixed-version rollout hazard", async () => {
    const { admin } = await seedAdmin();
    const newEmail = `legacy-change-admin-${randomUUID()}@example.test`;
    const reservationId = randomUUID();
    await db.insert(magicLinkTokens).values({
      email: newEmail,
      tokenHash: randomUUID().replaceAll("-", ""),
      keyId: "test",
      expiresAt: new Date(0),
      deliveryState: "pending",
      deliveredAt: null,
      deliveryReservationId: reservationId,
      deliveryReservationUntil: new Date(Date.now() - 60_000),
    });

    // This is the exact guarded UPDATE shape from changeAdminEmail on base
    // 80dbaa. That code has no advisory lock or reservation predicate, so it
    // demonstrates why old admin-operation executables must be absent in
    // Phase B rather than merely unable to claim the new queues.
    await db
      .update(users)
      .set({ email: newEmail, updatedAt: new Date() })
      .where(
        and(
          eq(users.id, admin.id),
          eq(users.email, admin.email),
          eq(users.passwordHash, admin.passwordHash!),
        ),
      );

    const [promoted] = await db.select().from(users).where(eq(users.id, admin.id));
    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, newEmail));
    expect(promoted).toMatchObject({ email: newEmail, role: "admin" });
    expect(candidate).toMatchObject({
      deliveryState: "pending",
      deliveryReservationId: reservationId,
    });
  });
});
