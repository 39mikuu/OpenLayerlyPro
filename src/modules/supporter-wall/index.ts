import { randomUUID } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { siteSettings, supporterWallEntries, type SupporterWallEntry, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  normalizeAdminPageSize,
} from "@/modules/admin/pagination";
import { type AuditActor, recordAudit } from "@/modules/audit";

const SUPPORTER_WALL_ENABLED_KEY = "supporterWallEnabled";
const SUPPORTER_WALL_MIN_LEVEL_KEY = "supporterWallMinLevel";
const SUPPORTER_WALL_SETTING_KEYS = [
  SUPPORTER_WALL_ENABLED_KEY,
  SUPPORTER_WALL_MIN_LEVEL_KEY,
] as const;
const MAX_DEDICATION_LENGTH = 200;
// Deterministic order means the top-200 by level/created_at render; boundedness per WP5 plan.
const PUBLIC_WALL_MAX_ENTRIES = 200;

type SupporterWallEntryStatus = "pending" | "approved" | "hidden";

export type SupporterWallSettings = {
  enabled: boolean;
  minLevel: number | null;
};

export type SupporterWallFanEntry = Pick<
  SupporterWallEntry,
  "id" | "dedication" | "status" | "version" | "createdAt" | "updatedAt"
>;

export type SupporterWallPublicItem = {
  displayName: string;
  tierName: string;
  dedication: string | null;
};

export type SupporterWallViewModel = {
  supporters: SupporterWallPublicItem[];
};

export type SupporterWallAdminListItem = {
  id: string;
  displayName: string | null;
  activeTierName: string | null;
  dedication: string | null;
  status: SupporterWallEntryStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SupporterWallAdminPage = {
  items: SupporterWallAdminListItem[];
  nextCursor: string | null;
};

type StoredSettingsParse = {
  settings: SupporterWallSettings;
  publicReadable: boolean;
};

type SettingRow = {
  id: string;
  key: string;
  valueJson: unknown;
};

type RawPublicSupporter = SupporterWallPublicItem & { level: number };

type RawAdminSupporter = {
  id: string;
  displayName: string | null;
  activeTierName: string | null;
  dedication: string | null;
  status: SupporterWallEntryStatus;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  cursorCreatedAt: string;
};

function assertDedication(dedication: string | null | undefined): string | null {
  if (dedication === undefined || dedication === null) return null;
  if (dedication.length > MAX_DEDICATION_LENGTH) {
    throw new ApiError(400, "supporterWallDedicationTooLong");
  }
  return dedication;
}

function pickEntryAudit(
  entry: Pick<SupporterWallEntry, "status" | "version"> | null,
): Record<string, unknown> | null {
  if (!entry) return null;
  return { status: entry.status, version: entry.version };
}

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseStoredSettings(rows: SettingRow[]): StoredSettingsParse {
  const enabledRow = rows.find((row) => row.key === SUPPORTER_WALL_ENABLED_KEY);
  const minLevelRow = rows.find((row) => row.key === SUPPORTER_WALL_MIN_LEVEL_KEY);
  const enabled = enabledRow?.valueJson === true;
  const enabledReadable =
    enabledRow === undefined ||
    typeof enabledRow.valueJson === "boolean" ||
    enabledRow.valueJson === null;

  if (minLevelRow === undefined || minLevelRow.valueJson === null) {
    return { settings: { enabled, minLevel: null }, publicReadable: enabledReadable };
  }
  if (
    typeof minLevelRow.valueJson === "number" &&
    Number.isInteger(minLevelRow.valueJson) &&
    minLevelRow.valueJson >= 0
  ) {
    return {
      settings: { enabled, minLevel: minLevelRow.valueJson },
      publicReadable: enabledReadable,
    };
  }
  return { settings: { enabled: false, minLevel: null }, publicReadable: false };
}

async function readSettingRows(dbc: DbClient): Promise<SettingRow[]> {
  return dbc
    .select({ id: siteSettings.id, key: siteSettings.key, valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...SUPPORTER_WALL_SETTING_KEYS]));
}

async function ensureAndLockSettingRows(dbc: DbClient): Promise<SettingRow[]> {
  await dbc
    .insert(siteSettings)
    .values([
      { key: SUPPORTER_WALL_ENABLED_KEY, valueJson: false },
      { key: SUPPORTER_WALL_MIN_LEVEL_KEY, valueJson: sql`'null'::jsonb` },
    ])
    .onConflictDoNothing({ target: siteSettings.key });

  return dbc
    .select({ id: siteSettings.id, key: siteSettings.key, valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...SUPPORTER_WALL_SETTING_KEYS]))
    .for("update");
}

export async function getSupporterWallSettings(
  dbc: DbClient = getDb(),
): Promise<SupporterWallSettings> {
  return parseStoredSettings(await readSettingRows(dbc)).settings;
}

export async function applySupporterWallSettingsUpdate(input: {
  enabled: boolean;
  minLevel: number | null;
  actor: AuditActor;
}): Promise<SupporterWallSettings> {
  if (input.minLevel !== null && (!Number.isInteger(input.minLevel) || input.minLevel < 0)) {
    throw new ApiError(400, "supporterWallInvalidMinLevel");
  }
  return getDb().transaction(async (tx) => {
    const rows = await ensureAndLockSettingRows(tx);
    const before = parseStoredSettings(rows).settings;
    const enabledRow = rows.find((row) => row.key === SUPPORTER_WALL_ENABLED_KEY);
    if (!enabledRow) throw new Error("Failed to lock supporter wall settings");
    const next = { enabled: input.enabled, minLevel: input.minLevel };
    const minLevelValue = next.minLevel === null ? sql`'null'::jsonb` : next.minLevel;

    await tx
      .insert(siteSettings)
      .values({ key: SUPPORTER_WALL_ENABLED_KEY, valueJson: next.enabled })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { valueJson: next.enabled, updatedAt: new Date() },
      });
    await tx
      .insert(siteSettings)
      .values({ key: SUPPORTER_WALL_MIN_LEVEL_KEY, valueJson: minLevelValue })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { valueJson: minLevelValue, updatedAt: new Date() },
      });

    await recordAudit(tx, {
      entityType: "supporter_wall_settings",
      entityId: enabledRow.id,
      action: "settings_update",
      actor: input.actor,
      before,
      after: next,
      correlationId: randomUUID(),
    });
    return next;
  });
}

export async function getMyWallEntry(
  userId: string,
  dbc: DbClient = getDb(),
): Promise<SupporterWallFanEntry | null> {
  const [entry] = await dbc
    .select({
      id: supporterWallEntries.id,
      dedication: supporterWallEntries.dedication,
      status: supporterWallEntries.status,
      version: supporterWallEntries.version,
      createdAt: supporterWallEntries.createdAt,
      updatedAt: supporterWallEntries.updatedAt,
    })
    .from(supporterWallEntries)
    .where(eq(supporterWallEntries.userId, userId))
    .limit(1);
  return entry ?? null;
}

export async function updateUserDisplayNameWithWallReset(input: {
  userId: string;
  displayName: string | null;
}): Promise<void> {
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const [currentUser] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    // Saving an unchanged name must not re-moderate an approved entry.
    if (!currentUser || currentUser.displayName === input.displayName) return;
    await tx
      .update(users)
      .set({ displayName: input.displayName, updatedAt: now })
      .where(eq(users.id, input.userId));

    const [before] = await tx
      .select({
        id: supporterWallEntries.id,
        status: supporterWallEntries.status,
        version: supporterWallEntries.version,
      })
      .from(supporterWallEntries)
      .where(eq(supporterWallEntries.userId, input.userId))
      .limit(1)
      .for("update");
    if (!before) return;

    // A pending entry keeps its status, but the version must still bump:
    // admin approve/hide fences on the version while the public wall reads
    // users.display_name live, so a stale-version approve after a rename
    // would publish a display name the moderator never reviewed.
    const [updated] = await tx
      .update(supporterWallEntries)
      .set({
        status: "pending",
        version: sql`${supporterWallEntries.version} + 1`,
        updatedAt: now,
      })
      .where(eq(supporterWallEntries.id, before.id))
      .returning({
        status: supporterWallEntries.status,
        version: supporterWallEntries.version,
      });
    if (!updated) throw new Error("Failed to reset supporter wall entry after display-name edit");

    await recordAudit(tx, {
      entityType: "supporter_wall_entry",
      entityId: before.id,
      action: "display_name_reset",
      actor: { type: "user", id: input.userId },
      before: pickEntryAudit(before),
      after: pickEntryAudit(updated),
      correlationId: randomUUID(),
    });
  });
}

export async function upsertOptIn(input: {
  userId: string;
  dedication?: string | null;
}): Promise<SupporterWallFanEntry> {
  const dedication = assertDedication(input.dedication);
  return getDb().transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!user) throw new ApiError(404, "userNotFound");
    if (!user.displayName?.trim()) throw new ApiError(400, "displayNameRequired");

    const now = new Date();
    const [before] = await tx
      .select()
      .from(supporterWallEntries)
      .where(eq(supporterWallEntries.userId, input.userId))
      .limit(1)
      .for("update");

    // A no-op or retried PUT with the same dedication must not pull an
    // approved entry back into moderation. Hidden entries still reset:
    // resubmitting is the fan's only way to request re-review.
    if (before && before.status !== "hidden" && before.dedication === dedication) {
      return {
        id: before.id,
        dedication: before.dedication,
        status: before.status,
        version: before.version,
        createdAt: before.createdAt,
        updatedAt: before.updatedAt,
      };
    }

    const [entry] = before
      ? await tx
          .update(supporterWallEntries)
          .set({
            dedication,
            status: "pending",
            version: sql`${supporterWallEntries.version} + 1`,
            updatedAt: now,
          })
          .where(eq(supporterWallEntries.id, before.id))
          .returning({
            id: supporterWallEntries.id,
            dedication: supporterWallEntries.dedication,
            status: supporterWallEntries.status,
            version: supporterWallEntries.version,
            createdAt: supporterWallEntries.createdAt,
            updatedAt: supporterWallEntries.updatedAt,
          })
      : await tx
          .insert(supporterWallEntries)
          .values({ userId: input.userId, dedication, status: "pending", updatedAt: now })
          .returning({
            id: supporterWallEntries.id,
            dedication: supporterWallEntries.dedication,
            status: supporterWallEntries.status,
            version: supporterWallEntries.version,
            createdAt: supporterWallEntries.createdAt,
            updatedAt: supporterWallEntries.updatedAt,
          });
    if (!entry) throw new Error("Failed to upsert supporter wall entry");

    if (before && before.status !== "pending") {
      await recordAudit(tx, {
        entityType: "supporter_wall_entry",
        entityId: before.id,
        action: "fan_edit_reset",
        actor: { type: "user", id: input.userId },
        before: pickEntryAudit(before),
        after: pickEntryAudit(entry),
        correlationId: randomUUID(),
      });
    }
    return entry;
  });
}

export async function optOut(input: {
  userId: string;
  actor?: AuditActor;
}): Promise<{ deleted: boolean }> {
  return getDb().transaction(async (tx) => {
    const [deleted] = await tx
      .delete(supporterWallEntries)
      .where(eq(supporterWallEntries.userId, input.userId))
      .returning();
    if (!deleted) return { deleted: false };
    await recordAudit(tx, {
      entityType: "supporter_wall_entry",
      entityId: deleted.id,
      action: "opt_out",
      actor: input.actor ?? { type: "user", id: input.userId },
      before: pickEntryAudit(deleted),
      after: null,
      correlationId: randomUUID(),
    });
    return { deleted: true };
  });
}

export async function getSupporterWallViewModel(): Promise<SupporterWallViewModel | null> {
  const db = getDb();
  const parsed = parseStoredSettings(await readSettingRows(db));
  if (!parsed.publicReadable || !parsed.settings.enabled) return null;
  const supporters = await db.execute<RawPublicSupporter>(
    buildPublicSupporterWallQuery(parsed.settings.minLevel),
  );
  return {
    supporters: supporters.map(({ level, ...supporter }) => {
      void level;
      return supporter;
    }),
  };
}

export function buildPublicSupporterWallQuery(threshold: number | null) {
  const thresholdSql = threshold === null ? sql`true` : sql`active.level >= ${threshold}`;
  return sql<RawPublicSupporter>`
    select
      u.display_name as "displayName",
      active.tier_name as "tierName",
      e.dedication,
      active.level
    from supporter_wall_entries e
    inner join users u on u.id = e.user_id and u.display_name is not null
    inner join lateral (
      select
        mt.name as tier_name,
        mt.level
      from memberships m
      inner join membership_tiers mt on mt.id = m.tier_id
      where m.user_id = e.user_id
        and m.status = 'active'
        and m.starts_at <= now()
        and m.ends_at > now()
      order by mt.level desc, m.ends_at desc, m.id asc
      limit 1
    ) active on true
    where e.status = 'approved'
      and ${thresholdSql}
    order by active.level desc, e.created_at asc, e.id asc
    limit ${PUBLIC_WALL_MAX_ENTRIES}
  `;
}

export async function listSupporterWallEntriesPage(
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<SupporterWallAdminPage> {
  const limit = normalizeAdminPageSize(opts.limit);
  const cursor = decodeAdminListCursor(opts.cursor, "supporter-wall");
  const cursorSql = cursor
    ? sql`where (e.created_at, e.id) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`
    : sql``;
  const rows = await getDb().execute<RawAdminSupporter>(sql`
    with active as (
      select distinct on (m.user_id)
        m.user_id,
        mt.name as tier_name,
        mt.level
      from memberships m
      inner join membership_tiers mt on mt.id = m.tier_id
      where m.status = 'active'
        and m.starts_at <= now()
        and m.ends_at > now()
      order by m.user_id, mt.level desc, m.ends_at desc, m.id asc
    )
    select
      e.id,
      u.display_name as "displayName",
      active.tier_name as "activeTierName",
      e.dedication,
      e.status,
      e.version,
      e.created_at as "createdAt",
      e.updated_at as "updatedAt",
      to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"
    from supporter_wall_entries e
    inner join users u on u.id = e.user_id
    left join active on active.user_id = e.user_id
    ${cursorSql}
    order by e.created_at desc, e.id desc
    limit ${limit + 1}
  `);
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(({ cursorCreatedAt, ...row }) => {
    void cursorCreatedAt;
    return { ...row, createdAt: coerceDate(row.createdAt), updatedAt: coerceDate(row.updatedAt) };
  });
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeAdminListCursor({
            version: 1,
            scope: "supporter-wall",
            timestamp: last.cursorCreatedAt,
            id: last.id,
          })
        : null,
  };
}

async function updateModerationStatus(input: {
  id: string;
  expectedVersion: number;
  status: Extract<SupporterWallEntryStatus, "approved" | "hidden">;
  action: "approve" | "hide";
  actor: AuditActor;
}): Promise<SupporterWallFanEntry> {
  return getDb().transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(supporterWallEntries)
      .where(eq(supporterWallEntries.id, input.id))
      .limit(1);
    if (!before) throw new ApiError(404, "supporterWallEntryNotFound");

    const now = new Date();
    const [updated] = await tx
      .update(supporterWallEntries)
      .set({
        status: input.status,
        version: sql`${supporterWallEntries.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(supporterWallEntries.id, input.id),
          eq(supporterWallEntries.version, input.expectedVersion),
        ),
      )
      .returning({
        id: supporterWallEntries.id,
        dedication: supporterWallEntries.dedication,
        status: supporterWallEntries.status,
        version: supporterWallEntries.version,
        createdAt: supporterWallEntries.createdAt,
        updatedAt: supporterWallEntries.updatedAt,
      });
    if (!updated) throw new ApiError(409, "supporterWallEntryStale");

    await recordAudit(tx, {
      entityType: "supporter_wall_entry",
      entityId: input.id,
      action: input.action,
      actor: input.actor,
      before: pickEntryAudit(before),
      after: pickEntryAudit(updated),
      correlationId: randomUUID(),
    });
    return updated;
  });
}

export async function approveSupporterWallEntry(input: {
  id: string;
  expectedVersion: number;
  actor: AuditActor;
}): Promise<SupporterWallFanEntry> {
  return updateModerationStatus({ ...input, status: "approved", action: "approve" });
}

export async function hideSupporterWallEntry(input: {
  id: string;
  expectedVersion: number;
  actor: AuditActor;
}): Promise<SupporterWallFanEntry> {
  return updateModerationStatus({ ...input, status: "hidden", action: "hide" });
}
