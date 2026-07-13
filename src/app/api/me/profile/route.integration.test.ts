import { randomUUID } from "crypto";
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
import { users } from "@/db/schema";
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
  });
});
