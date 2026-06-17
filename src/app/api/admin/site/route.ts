import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { deleteSetting, readAdminSiteInfo, setSetting } from "@/modules/site";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await readAdminSiteInfo());
  } catch (err) {
    return handleApiError(err);
  }
}

const bodySchema = z.object({
  siteName: z.string().min(1).max(100).optional(),
  artistName: z.string().min(1).max(100).optional(),
  artistBio: z.string().max(2000).optional(),
  artistAvatarFileId: z.string().uuid().nullable().optional(),
  siteLogoFileId: z.string().uuid().nullable().optional(),
  siteIconFileId: z.string().uuid().nullable().optional(),
  customFooterHtml: z.string().max(20000).optional(),
  socialLinks: z
    .array(
      z.object({
        name: z.string().min(1).max(50),
        url: z.string().url(),
        sortOrder: z.number().int().optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .optional(),
});

export async function PUT(req: NextRequest) {
  try {
    await requireAdmin();
    const input = bodySchema.parse(await req.json());
    if (input.siteName !== undefined) await setSetting("site_name", input.siteName);
    if (input.artistName !== undefined) await setSetting("artist_name", input.artistName);
    if (input.artistBio !== undefined) await setSetting("artist_bio", input.artistBio);
    if (input.artistAvatarFileId !== undefined)
      await writeOptionalFileSetting("artist_avatar_file_id", input.artistAvatarFileId);
    if (input.siteLogoFileId !== undefined)
      await writeOptionalFileSetting("site_logo_file_id", input.siteLogoFileId);
    if (input.siteIconFileId !== undefined)
      await writeOptionalFileSetting("site_icon_file_id", input.siteIconFileId);
    if (input.customFooterHtml !== undefined)
      await setSetting("custom_footer_html", input.customFooterHtml);
    if (input.socialLinks !== undefined) await setSetting("social_links", input.socialLinks);
    return jsonOk(await readAdminSiteInfo());
  } catch (err) {
    return handleApiError(err);
  }
}

async function writeOptionalFileSetting(key: string, fileId: string | null) {
  if (fileId === null) {
    await deleteSetting(key);
    return;
  }
  await setSetting(key, fileId);
}
