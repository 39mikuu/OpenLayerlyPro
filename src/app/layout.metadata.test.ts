import { describe, expect, it } from "vitest";

import { buildPublicUrl } from "@/modules/content/public-projection";
import { buildRootMetadataFromSite } from "@/modules/content/root-metadata";

describe("root layout metadata", () => {
  it("sets explicit website OpenGraph title, type, and canonical URL", () => {
    const metadata = buildRootMetadataFromSite(
      {
        initialized: true,
        siteName: "Root Studio",
        artistName: "Artist",
        artistBio: "Root bio",
        artistAvatarFileId: null,
        siteLogoFileId: null,
        siteIconFileId: null,
        socialLinks: [],
      },
      "https://artist.example",
    );

    expect(metadata.title).toBe("Root Studio");
    expect(metadata.openGraph).toMatchObject({
      title: "Root Studio",
      type: "website",
      url: buildPublicUrl("https://artist.example", "/"),
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary",
      title: "Root Studio",
    });
  });

  it("falls back to root default metadata when site fields are blank", () => {
    const metadata = buildRootMetadataFromSite(
      {
        initialized: true,
        siteName: "",
        artistName: "Artist",
        artistBio: "",
        artistAvatarFileId: null,
        siteLogoFileId: null,
        siteIconFileId: null,
        socialLinks: [],
      },
      "https://artist.example",
    );

    expect(metadata.title).toBe("Artist Member Site");
    expect(metadata.description).toBe("开源画师会员站系统");
    expect(metadata.openGraph).toMatchObject({
      title: "Artist Member Site",
      type: "website",
    });
  });
});
