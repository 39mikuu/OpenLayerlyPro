import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentUserId: "" }));

vi.mock("@/modules/auth/session", async () => {
  const { ApiError } = await import("@/lib/api");
  const { findUserById } = await import("@/modules/user");
  return {
    requireUser: async () => {
      const user = mocks.currentUserId ? await findUserById(mocks.currentUserId) : null;
      if (!user) throw new ApiError(401, "authRequired");
      return user;
    },
    getCurrentUser: async () =>
      mocks.currentUserId ? await findUserById(mocks.currentUserId) : null,
  };
});

import { getDb } from "@/db";
import { auditEvents, supporterWallEntries, users } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import { GET as GET_ME } from "../../auth/me/route";
import { PATCH } from "./route";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/me/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describeWithDatabase("profile route integration", () => {
  const db = getDb();

  beforeEach(async () => {
    mocks.currentUserId = "";
    await resetDatabase(db);
  });

  it("persists displayName and /api/auth/me reflects the update", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `profile-${randomUUID()}@example.test` })
      .returning();
    mocks.currentUserId = user!.id;

    const updateResponse = await PATCH(request({ displayName: "  Public Fan  " }));
    const meResponse = await GET_ME();

    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      data: { displayName: "Public Fan" },
    });
    await expect(meResponse.json()).resolves.toMatchObject({
      data: { id: user!.id, email: user!.email, displayName: "Public Fan" },
    });
    await expect(db.select().from(supporterWallEntries)).resolves.toHaveLength(0);
  });

  it.each([
    ["approved", "  Reviewed Name  ", "Reviewed Name"],
    ["hidden", null, null],
  ] as const)(
    "resets an %s supporter wall entry to pending and audits the display-name change",
    async (status, displayName, expectedDisplayName) => {
      const [user] = await db
        .insert(users)
        .values({ email: `profile-${randomUUID()}@example.test`, displayName: "Old Name" })
        .returning();
      const [entry] = await db
        .insert(supporterWallEntries)
        .values({
          userId: user!.id,
          dedication: "reviewed text",
          status,
          version: 7,
        })
        .returning();
      mocks.currentUserId = user!.id;

      const response = await PATCH(request({ displayName }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: { displayName: expectedDisplayName },
      });
      await expect(
        db
          .select({
            displayName: users.displayName,
          })
          .from(users)
          .where(eq(users.id, user!.id)),
      ).resolves.toEqual([{ displayName: expectedDisplayName }]);
      await expect(
        db
          .select({
            status: supporterWallEntries.status,
            version: supporterWallEntries.version,
          })
          .from(supporterWallEntries)
          .where(eq(supporterWallEntries.id, entry!.id)),
      ).resolves.toEqual([{ status: "pending", version: 8 }]);
      await expect(
        db
          .select({
            action: auditEvents.action,
            actorType: auditEvents.actorType,
            actorId: auditEvents.actorId,
            beforeJson: auditEvents.beforeJson,
            afterJson: auditEvents.afterJson,
          })
          .from(auditEvents)
          .where(eq(auditEvents.entityId, entry!.id)),
      ).resolves.toEqual([
        {
          action: "display_name_reset",
          actorType: "user",
          actorId: user!.id,
          beforeJson: { status, version: 7 },
          afterJson: { status: "pending", version: 8 },
        },
      ]);
    },
  );

  it("leaves a pending supporter wall entry pending without audit spam", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `profile-${randomUUID()}@example.test`, displayName: "Pending Fan" })
      .returning();
    const [entry] = await db
      .insert(supporterWallEntries)
      .values({
        userId: user!.id,
        dedication: "pending text",
        status: "pending",
        version: 4,
      })
      .returning();
    mocks.currentUserId = user!.id;

    const response = await PATCH(request({ displayName: "New Pending Fan" }));

    expect(response.status).toBe(200);
    await expect(
      db
        .select({
          status: supporterWallEntries.status,
          version: supporterWallEntries.version,
        })
        .from(supporterWallEntries)
        .where(eq(supporterWallEntries.id, entry!.id)),
    ).resolves.toEqual([{ status: "pending", version: 4 }]);
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
  });
});
