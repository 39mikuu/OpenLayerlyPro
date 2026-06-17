import { eq, inArray } from "drizzle-orm";
import { cache } from "react";

import { getDb } from "@/db";
import { membershipTiers, siteSettings, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { hashPassword } from "@/lib/crypto";
import { recordEvent } from "@/modules/system/events";

export type SocialLink = {
  name: string;
  url: string;
  sortOrder?: number;
  enabled?: boolean;
};

export type PublicSiteInfo = {
  initialized: boolean;
  siteName: string;
  artistName: string;
  artistBio: string;
  artistAvatarFileId: string | null;
  siteLogoFileId: string | null;
  siteIconFileId: string | null;
  socialLinks: SocialLink[];
};

export type AdminSiteInfo = PublicSiteInfo & {
  customFooterHtml: string;
};

export async function getSetting<T>(key: string): Promise<T | null> {
  const [row] = await getDb().select().from(siteSettings).where(eq(siteSettings.key, key)).limit(1);
  return row ? (row.valueJson as T) : null;
}

export async function getSettings(keys: string[]): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  const rows = await getDb().select().from(siteSettings).where(inArray(siteSettings.key, keys));
  return Object.fromEntries(rows.map((row) => [row.key, row.valueJson]));
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(siteSettings)
    .values({ key, valueJson: value })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { valueJson: value, updatedAt: new Date() },
    });
}

export async function deleteSetting(key: string): Promise<void> {
  await getDb().delete(siteSettings).where(eq(siteSettings.key, key));
}

function stringSetting(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStringSetting(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function isInitialized(): Promise<boolean> {
  return (await getSetting<boolean>("initialized")) === true;
}

const PUBLIC_SITE_SETTING_KEYS = [
  "initialized",
  "site_name",
  "artist_name",
  "artist_bio",
  "artist_avatar_file_id",
  "site_logo_file_id",
  "site_icon_file_id",
  "social_links",
] as const;

const ADMIN_SITE_SETTING_KEYS = [...PUBLIC_SITE_SETTING_KEYS, "custom_footer_html"] as const;

export async function readPublicSiteInfo(): Promise<PublicSiteInfo> {
  const settings = await getSettings([...PUBLIC_SITE_SETTING_KEYS]);
  const socialLinks = settings.social_links;
  return {
    initialized: settings.initialized === true,
    siteName: stringSetting(settings.site_name, "Artist Member Site"),
    artistName: stringSetting(settings.artist_name),
    artistBio: stringSetting(settings.artist_bio),
    artistAvatarFileId: nullableStringSetting(settings.artist_avatar_file_id),
    siteLogoFileId: nullableStringSetting(settings.site_logo_file_id),
    siteIconFileId: nullableStringSetting(settings.site_icon_file_id),
    socialLinks: Array.isArray(socialLinks) ? (socialLinks as SocialLink[]) : [],
  };
}

export const getPublicSiteInfo = cache(readPublicSiteInfo);

export async function readCustomFooterHtml(): Promise<string> {
  const value = await getSetting<unknown>("custom_footer_html");
  return typeof value === "string" ? value : "";
}

export const getCustomFooterHtml = cache(readCustomFooterHtml);

export async function readAdminSiteInfo(): Promise<AdminSiteInfo> {
  const settings = await getSettings([...ADMIN_SITE_SETTING_KEYS]);
  const socialLinks = settings.social_links;
  return {
    initialized: settings.initialized === true,
    siteName: stringSetting(settings.site_name, "Artist Member Site"),
    artistName: stringSetting(settings.artist_name),
    artistBio: stringSetting(settings.artist_bio),
    artistAvatarFileId: nullableStringSetting(settings.artist_avatar_file_id),
    siteLogoFileId: nullableStringSetting(settings.site_logo_file_id),
    siteIconFileId: nullableStringSetting(settings.site_icon_file_id),
    socialLinks: Array.isArray(socialLinks) ? (socialLinks as SocialLink[]) : [],
    customFooterHtml:
      typeof settings.custom_footer_html === "string" ? settings.custom_footer_html : "",
  };
}

const DEFAULT_TIERS = [
  {
    name: "支持者",
    slug: "supporter",
    priceLabel: "¥9 / 月",
    level: 10,
    durationDays: 31,
    sortOrder: 1,
  },
  {
    name: "高清图会员",
    slug: "hd-member",
    priceLabel: "¥29 / 月",
    level: 20,
    durationDays: 31,
    sortOrder: 2,
  },
  {
    name: "素材包会员",
    slug: "pack-member",
    priceLabel: "¥59 / 月",
    level: 30,
    durationDays: 31,
    sortOrder: 3,
  },
];

export async function setupSite(input: {
  siteName: string;
  artistName: string;
  artistBio: string;
  adminEmail: string;
  adminPassword: string;
}): Promise<void> {
  if (await isInitialized()) {
    throw new ApiError(403, "siteInitialized");
  }
  const passwordHash = await hashPassword(input.adminPassword);
  const email = input.adminEmail.trim().toLowerCase();
  const db = getDb();

  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ email, passwordHash, role: "admin", displayName: input.artistName })
      .onConflictDoUpdate({
        target: users.email,
        set: { passwordHash, role: "admin", updatedAt: new Date() },
      });
    await tx.insert(membershipTiers).values(DEFAULT_TIERS);

    const settings: Record<string, unknown> = {
      initialized: true,
      site_name: input.siteName,
      artist_name: input.artistName,
      artist_bio: input.artistBio,
      social_links: [],
    };
    for (const [key, value] of Object.entries(settings)) {
      await tx
        .insert(siteSettings)
        .values({ key, valueJson: value })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { valueJson: value, updatedAt: new Date() },
        });
    }
  });
  await recordEvent("site_initialized", { adminEmail: email });
}
