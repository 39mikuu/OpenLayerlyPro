import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";

vi.mock("@/db", () => ({
  getDb: vi.fn(),
}));

const mockedGetDb = vi.mocked(getDb);

function mockSettingsRows(rows: Array<{ key: string; valueJson: unknown }>) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  mockedGetDb.mockReturnValue({ select } as never);
  return { select, from, where };
}

describe("site settings reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty object without querying for an empty key list", async () => {
    const { getSettings } = await import("./index");

    await expect(getSettings([])).resolves.toEqual({});
    expect(mockedGetDb).not.toHaveBeenCalled();
  });

  it("maps a batch query to key and valueJson", async () => {
    const query = mockSettingsRows([
      { key: "a", valueJson: "first" },
      { key: "b", valueJson: { nested: true } },
    ]);
    const { getSettings } = await import("./index");

    await expect(getSettings(["a", "b"])).resolves.toEqual({
      a: "first",
      b: { nested: true },
    });
    expect(query.select).toHaveBeenCalledTimes(1);
    expect(query.where).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original public site defaults with one batch query", async () => {
    const query = mockSettingsRows([]);
    const { readPublicSiteInfo } = await import("./index");

    await expect(readPublicSiteInfo()).resolves.toEqual({
      initialized: false,
      siteName: "Artist Member Site",
      artistName: "",
      artistBio: "",
      artistAvatarFileId: null,
      siteLogoFileId: null,
      siteIconFileId: null,
      socialLinks: [],
    });
    expect(query.select).toHaveBeenCalledTimes(1);
    expect(query.where).toHaveBeenCalledTimes(1);
  });

  it("keeps social links empty when the stored value is missing or not an array", async () => {
    mockSettingsRows([
      { key: "initialized", valueJson: true },
      { key: "social_links", valueJson: { invalid: true } },
    ]);
    const { readPublicSiteInfo } = await import("./index");

    const info = await readPublicSiteInfo();

    expect(info.initialized).toBe(true);
    expect(info.socialLinks).toEqual([]);
  });

  it("returns stored public fields and preserves initialized as a boolean", async () => {
    const query = mockSettingsRows([
      { key: "initialized", valueJson: true },
      { key: "site_name", valueJson: "Studio" },
      { key: "artist_name", valueJson: "Artist" },
      { key: "artist_bio", valueJson: "Bio" },
      { key: "artist_avatar_file_id", valueJson: "file-1" },
      { key: "site_logo_file_id", valueJson: "logo-1" },
      { key: "site_icon_file_id", valueJson: "icon-1" },
      {
        key: "social_links",
        valueJson: [{ name: "Site", url: "https://example.com" }],
      },
    ]);
    const { getPublicSiteInfo } = await import("./index");

    await expect(getPublicSiteInfo()).resolves.toEqual({
      initialized: true,
      siteName: "Studio",
      artistName: "Artist",
      artistBio: "Bio",
      artistAvatarFileId: "file-1",
      siteLogoFileId: "logo-1",
      siteIconFileId: "icon-1",
      socialLinks: [{ name: "Site", url: "https://example.com" }],
    });
    expect(query.select).toHaveBeenCalledTimes(1);
  });

  it("falls back when text and file settings contain non-string JSON values", async () => {
    mockSettingsRows([
      { key: "initialized", valueJson: true },
      { key: "site_name", valueJson: 1 },
      { key: "artist_name", valueJson: { invalid: true } },
      { key: "artist_bio", valueJson: ["Bio"] },
      { key: "artist_avatar_file_id", valueJson: 2 },
      { key: "site_logo_file_id", valueJson: false },
      { key: "site_icon_file_id", valueJson: { id: "icon-1" } },
    ]);
    const { readPublicSiteInfo } = await import("./index");

    await expect(readPublicSiteInfo()).resolves.toMatchObject({
      initialized: true,
      siteName: "Artist Member Site",
      artistName: "",
      artistBio: "",
      artistAvatarFileId: null,
      siteLogoFileId: null,
      siteIconFileId: null,
    });
  });

  it("keeps custom footer HTML out of public site info but returns it for admin settings", async () => {
    mockSettingsRows([
      { key: "site_name", valueJson: "Studio" },
      { key: "custom_footer_html", valueJson: "<script>window.x=1</script>" },
    ]);
    const { readAdminSiteInfo, readPublicSiteInfo } = await import("./index");

    await expect(readPublicSiteInfo()).resolves.not.toHaveProperty("customFooterHtml");
    await expect(readAdminSiteInfo()).resolves.toMatchObject({
      siteName: "Studio",
      customFooterHtml: "<script>window.x=1</script>",
    });
  });
});
