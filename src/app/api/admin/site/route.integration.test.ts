import { eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireAdminSession: vi.fn(),
  readAdminSiteInfo: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({
  requireAdmin: mocks.requireAdmin,
  requireAdminSession: mocks.requireAdminSession,
}));
vi.mock("@/modules/site", () => ({
  readAdminSiteInfo: mocks.readAdminSiteInfo,
}));

import { getDb } from "@/db";
import { auditEvents, siteSettings } from "@/db/schema";
import {
  PUBLIC_CSP_REVISION_KEY,
  PUBLIC_INTEGRATIONS_KEY,
  PUBLIC_SECURITY_SETTING_KEYS,
} from "@/modules/site/public-security";

import { PUT } from "./route";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const admin = { id: "00000000-0000-4000-8000-000000000001", role: "admin" };

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/admin/site", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describeWithDatabase("admin site settings API integration", () => {
  const db = getDb();

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(admin);
    mocks.requireAdminSession.mockResolvedValue({ user: admin, tokenHash: "current-hash" });
    mocks.readAdminSiteInfo.mockResolvedValue({ ok: true });
    await db.delete(auditEvents);
    await db
      .delete(siteSettings)
      .where(inArray(siteSettings.key, [...PUBLIC_SECURITY_SETTING_KEYS]));
  });

  it("writes an audit event when the admin route updates public integrations", async () => {
    await db.insert(siteSettings).values({ key: PUBLIC_CSP_REVISION_KEY, valueJson: "revision" });

    const response = await PUT(
      request({
        cspRevision: "revision",
        publicIntegrations: [
          {
            id: "analytics",
            provider: "umami",
            websiteId: "33333333-3333-4333-8333-333333333333",
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "public_security_settings_updated"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "public_security_settings",
      actorType: "admin",
      actorId: admin.id,
    });
    expect(audits[0]!.beforeJson).toEqual({ [PUBLIC_INTEGRATIONS_KEY]: [] });
    expect(audits[0]!.afterJson).toEqual({
      [PUBLIC_INTEGRATIONS_KEY]: [
        expect.objectContaining({ provider: "umami", id: "analytics", enabled: true }),
      ],
    });
  });
});
