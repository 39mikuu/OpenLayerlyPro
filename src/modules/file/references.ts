import { asc, inArray } from "drizzle-orm";

import type { TxClient } from "@/db";
import { type FileRecord, files } from "@/db/schema";
import { ApiError } from "@/lib/api";

export type FileReferenceInvalidReason = "missing" | "quarantined" | "owner";

export type FileReferenceRequirement = {
  fileId: string;
  ownerId?: string;
  invalid: (reason: FileReferenceInvalidReason, record: FileRecord | null) => Error;
  validate?: (record: FileRecord) => void;
};

/**
 * Locks every referenced file in deterministic id order for the lifetime of the
 * caller's transaction. FOR SHARE conflicts with quarantine updates and file
 * deletion while remaining compatible with other reference creators.
 */
export async function lockFileReferences(
  tx: TxClient,
  requirements: readonly FileReferenceRequirement[],
): Promise<Map<string, FileRecord>> {
  if (requirements.length === 0) return new Map();

  const ids = [
    ...new Set(requirements.map((requirement) => requirement.fileId.toLowerCase())),
  ].sort();
  const records = await tx
    .select()
    .from(files)
    .where(inArray(files.id, ids))
    .orderBy(asc(files.id))
    .for("share");
  // Postgres compares uuid columns case-insensitively, so a caller-supplied id
  // with uppercase hex still matches a row here, but the driver always returns
  // `record.id` in lowercase canonical form. Look records up by normalized
  // (lowercase) id so an uppercase-hex fileId isn't reported as missing, but
  // key the returned map by each requirement's original fileId so callers can
  // reliably look up results with the exact value they passed in.
  const byNormalizedId = new Map(records.map((record) => [record.id.toLowerCase(), record]));
  const byRequestedId = new Map<string, FileRecord>();

  for (const requirement of requirements) {
    const record = byNormalizedId.get(requirement.fileId.toLowerCase()) ?? null;
    if (!record) throw requirement.invalid("missing", null);
    if (record.quarantinedAt) throw requirement.invalid("quarantined", record);
    if (requirement.ownerId !== undefined && record.createdBy !== requirement.ownerId) {
      throw requirement.invalid("owner", record);
    }
    requirement.validate?.(record);
    byRequestedId.set(requirement.fileId, record);
  }

  return byRequestedId;
}

export const SITE_FILE_SETTING_KEYS = [
  "artist_avatar_file_id",
  "site_logo_file_id",
  "site_icon_file_id",
] as const;

export type SiteFileSettingKey = (typeof SITE_FILE_SETTING_KEYS)[number];

export function isSiteFileSettingKey(key: string): key is SiteFileSettingKey {
  return (SITE_FILE_SETTING_KEYS as readonly string[]).includes(key);
}

export async function lockSiteFileSettingReferences(
  tx: TxClient,
  settings: Readonly<Record<string, unknown>>,
): Promise<void> {
  const requirements: FileReferenceRequirement[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!isSiteFileSettingKey(key)) continue;
    if (typeof value !== "string") {
      throw new ApiError(400, "invalidRequest", { field: key });
    }
    requirements.push({
      fileId: value,
      invalid: (reason) =>
        reason === "quarantined"
          ? new ApiError(410, "fileQuarantined")
          : new ApiError(400, "invalidRequest", { field: key }),
      validate: (record) => {
        if (record.purpose !== "artist_avatar") {
          throw new ApiError(400, "invalidRequest", { field: key });
        }
      },
    });
  }
  await lockFileReferences(tx, requirements);
}
