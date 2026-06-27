import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  readAdminSiteInfo: vi.fn(),
  updatePublicSecuritySettings: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/modules/site", () => ({
  readAdminSiteInfo: mocks.readAdminSiteInfo,
}));
vi.mock("@/modules/site/public-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/site/public-security")>();
  return {
    ...actual,
    updatePublicSecuritySettings: mocks.updatePublicSecuritySettings,
  };
});

import { GET, PUT } from "./route";

const siteInfo = {
  initialized: true,
  siteName: "Artist Member Site",
  artistName: "Artist",
  artistBio: "",
  artistAvatarFileId: null,
  siteLogoFileId: null,
  siteIconFileId: null,
  customFooterMarkup: "",
  legacyFooterHtml: "",
  legacyFooterStatus: "empty",
  siteVerification: [],
  publicIntegrations: [],
  cspRevision: "revision",
  cspMode: "auto",
  effectiveCspMode: "enforce",
  publicSecurityConfigurationErrors: [],
  socialLinks: [],
};

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/admin/site", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("admin site settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.readAdminSiteInfo.mockResolvedValue(siteInfo);
    mocks.updatePublicSecuritySettings.mockResolvedValue(undefined);
  });

  it("returns admin site settings for GET", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.readAdminSiteInfo).toHaveBeenCalledTimes(1);
  });

  it("uses the admin reader after writing settings", async () => {
    const response = await PUT(
      request({
        cspRevision: "revision",
        siteName: "Updated site",
        siteLogoFileId: "11111111-1111-4111-8111-111111111111",
        siteIconFileId: "22222222-2222-4222-8222-222222222222",
        customFooterMarkup: "<p>ICP</p>",
        siteVerification: [{ provider: "google", content: "token" }],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updatePublicSecuritySettings).toHaveBeenCalledWith({
      expectedRevision: "revision",
      customFooterMarkup: "<p>ICP</p>",
      siteVerification: [{ provider: "google", content: "token" }],
      publicIntegrations: undefined,
      legacyAction: undefined,
      additionalSettings: {
        site_name: "Updated site",
        site_logo_file_id: "11111111-1111-4111-8111-111111111111",
        site_icon_file_id: "22222222-2222-4222-8222-222222222222",
      },
      deleteSettingKeys: [],
    });
    expect(mocks.readAdminSiteInfo).toHaveBeenCalledTimes(1);
  });

  it("deletes optional file settings instead of writing SQL null", async () => {
    const response = await PUT(
      request({
        cspRevision: "revision",
        artistAvatarFileId: null,
        siteLogoFileId: null,
        siteIconFileId: null,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updatePublicSecuritySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: "revision",
        additionalSettings: {},
        deleteSettingKeys: ["artist_avatar_file_id", "site_logo_file_id", "site_icon_file_id"],
      }),
    );
  });

  it("rejects stale clients that submit the retired custom footer field", async () => {
    const response = await PUT(
      request({ cspRevision: "revision", customFooterHtml: "<script>legacy()</script>" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "legacyFooterClientRefreshRequired",
    });
    expect(mocks.updatePublicSecuritySettings).not.toHaveBeenCalled();
  });

  it("requires the current CSP revision from every settings client", async () => {
    const response = await PUT(request({ siteName: "stale client" }));

    expect(response.status).toBe(400);
    expect(mocks.updatePublicSecuritySettings).not.toHaveBeenCalled();
  });
});
