import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  readAdminSiteInfo: vi.fn(),
  deleteSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/modules/site", () => ({
  deleteSetting: mocks.deleteSetting,
  readAdminSiteInfo: mocks.readAdminSiteInfo,
  setSetting: mocks.setSetting,
}));

import { GET, PUT } from "./route";

const siteInfo = {
  initialized: true,
  siteName: "Artist Member Site",
  artistName: "Artist",
  artistBio: "",
  artistAvatarFileId: null,
  siteLogoFileId: null,
  siteIconFileId: null,
  customFooterHtml: "",
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
    mocks.deleteSetting.mockResolvedValue(undefined);
    mocks.setSetting.mockResolvedValue(undefined);
  });

  it("returns admin site settings for GET", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.readAdminSiteInfo).toHaveBeenCalledTimes(1);
  });

  it("uses the admin reader after writing settings", async () => {
    const response = await PUT(
      request({
        siteName: "Updated site",
        siteLogoFileId: "11111111-1111-4111-8111-111111111111",
        siteIconFileId: "22222222-2222-4222-8222-222222222222",
        customFooterHtml: "<script>window.analytics=true</script>",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.setSetting).toHaveBeenCalledWith("site_name", "Updated site");
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "site_logo_file_id",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "site_icon_file_id",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "custom_footer_html",
      "<script>window.analytics=true</script>",
    );
    expect(mocks.readAdminSiteInfo).toHaveBeenCalledTimes(1);
  });

  it("deletes optional file settings instead of writing SQL null", async () => {
    const response = await PUT(
      request({
        artistAvatarFileId: null,
        siteLogoFileId: null,
        siteIconFileId: null,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.deleteSetting).toHaveBeenCalledWith("artist_avatar_file_id");
    expect(mocks.deleteSetting).toHaveBeenCalledWith("site_logo_file_id");
    expect(mocks.deleteSetting).toHaveBeenCalledWith("site_icon_file_id");
    expect(mocks.setSetting).not.toHaveBeenCalledWith("artist_avatar_file_id", null);
    expect(mocks.setSetting).not.toHaveBeenCalledWith("site_logo_file_id", null);
    expect(mocks.setSetting).not.toHaveBeenCalledWith("site_icon_file_id", null);
  });
});
