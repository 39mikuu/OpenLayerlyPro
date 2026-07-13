import { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError, handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin, requireAdminSession } from "@/modules/auth/session";
import { readAdminSiteInfo } from "@/modules/site";
import {
  publicIntegrationsSchema,
  siteVerificationSchema,
  updatePublicSecuritySettings,
} from "@/modules/site/public-security";

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
  cspRevision: z.string().min(1).max(100),
  siteName: z.string().min(1).max(100).optional(),
  artistName: z.string().min(1).max(100).optional(),
  artistBio: z.string().max(2000).optional(),
  artistAvatarFileId: z.string().uuid().nullable().optional(),
  siteLogoFileId: z.string().uuid().nullable().optional(),
  siteIconFileId: z.string().uuid().nullable().optional(),
  customFooterHtml: z.unknown().optional(),
  customFooterMarkup: z.string().max(20000).optional(),
  siteVerification: siteVerificationSchema.optional(),
  publicIntegrations: publicIntegrationsSchema.optional(),
  legacyFooterAction: z.enum(["migrate-safe", "clear"]).optional(),
  paymentProofApprovedRetentionDays: z.number().int().min(0).max(3650).optional(),
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
    const { user } = await requireAdminSession();
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    if (input.customFooterHtml !== undefined) {
      throw new ApiError(409, "legacyFooterClientRefreshRequired");
    }
    const additionalSettings: Record<string, unknown> = {};
    const deleteSettingKeys: string[] = [];
    if (input.siteName !== undefined) additionalSettings.site_name = input.siteName;
    if (input.artistName !== undefined) additionalSettings.artist_name = input.artistName;
    if (input.artistBio !== undefined) additionalSettings.artist_bio = input.artistBio;
    collectOptionalFileSetting(
      additionalSettings,
      deleteSettingKeys,
      "artist_avatar_file_id",
      input.artistAvatarFileId,
    );
    collectOptionalFileSetting(
      additionalSettings,
      deleteSettingKeys,
      "site_logo_file_id",
      input.siteLogoFileId,
    );
    collectOptionalFileSetting(
      additionalSettings,
      deleteSettingKeys,
      "site_icon_file_id",
      input.siteIconFileId,
    );
    if (input.paymentProofApprovedRetentionDays !== undefined) {
      additionalSettings.payment_proof_approved_retention_days =
        input.paymentProofApprovedRetentionDays;
    }
    if (input.socialLinks !== undefined) additionalSettings.social_links = input.socialLinks;
    await updatePublicSecuritySettings({
      actor: { type: "admin", id: user.id },
      expectedRevision: input.cspRevision,
      customFooterMarkup: input.customFooterMarkup,
      siteVerification: input.siteVerification,
      publicIntegrations: input.publicIntegrations,
      legacyAction: input.legacyFooterAction,
      additionalSettings,
      deleteSettingKeys,
    });
    return jsonOk(await readAdminSiteInfo());
  } catch (err) {
    return handleApiError(err);
  }
}

function collectOptionalFileSetting(
  additionalSettings: Record<string, unknown>,
  deleteSettingKeys: string[],
  key: string,
  fileId: string | null | undefined,
) {
  if (fileId === undefined) return;
  if (fileId === null) {
    deleteSettingKeys.push(key);
    return;
  }
  additionalSettings[key] = fileId;
}
