import { and, eq, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

export type StoredGroupSnapshot<T> = {
  value: Partial<T> | null;
  revision: number;
};

function conflict(): never {
  throw new ApiError(409, "configConflict");
}

export async function getStoredGroupRevision(
  group: string,
  db: DbClient = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ revision: appSettings.revision })
    .from(appSettings)
    .where(eq(appSettings.key, group))
    .limit(1);
  return row?.revision ?? 0;
}

export async function getStoredGroupSnapshot<T>(
  group: string,
  db: DbClient = getDb(),
): Promise<StoredGroupSnapshot<T>> {
  const [row] = await db
    .select({ valueEncrypted: appSettings.valueEncrypted, revision: appSettings.revision })
    .from(appSettings)
    .where(eq(appSettings.key, group))
    .limit(1);
  if (!row) return { value: null, revision: 0 };
  if (row.valueEncrypted === null) return { value: null, revision: row.revision };
  return {
    value: JSON.parse(decryptSecret(row.valueEncrypted)) as Partial<T>,
    revision: row.revision,
  };
}

/**
 * 加密配置存储:每个「配置组」(如 smtp)以一行存储,value 为整组配置 JSON 的
 * AES-256-GCM 密文。读取时解密并 JSON.parse,无记录返回 null;解密/解析失败抛错,
 * 不静默吞掉(便于在密钥错误或数据损坏时尽早暴露)。
 */
export async function getStoredGroup<T>(
  group: string,
  db: DbClient = getDb(),
): Promise<Partial<T> | null> {
  return (await getStoredGroupSnapshot<T>(group, db)).value;
}

export async function setStoredGroup<T>(
  group: string,
  value: Partial<T>,
  expectedRevision = 0,
  db: DbClient = getDb(),
): Promise<number> {
  const valueEncrypted = encryptSecret(JSON.stringify(value));
  if (expectedRevision === 0) {
    const inserted = await db
      .insert(appSettings)
      .values({ key: group, valueEncrypted, revision: 1 })
      .onConflictDoNothing()
      .returning({ revision: appSettings.revision });
    if (inserted.length === 0) conflict();
    return inserted[0].revision;
  }

  const updated = await db
    .update(appSettings)
    .set({
      valueEncrypted,
      revision: sql`${appSettings.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(appSettings.key, group), eq(appSettings.revision, expectedRevision)))
    .returning({ revision: appSettings.revision });
  if (updated.length === 0) conflict();
  return updated[0].revision;
}

/** 清除配置组但保留单调 revision，避免 clear/recreate 后旧 revision 再次匹配。 */
export async function deleteStoredGroup(
  group: string,
  expectedRevision = 0,
  db: DbClient = getDb(),
): Promise<number> {
  if (expectedRevision === 0) {
    const inserted = await db
      .insert(appSettings)
      .values({ key: group, valueEncrypted: null, revision: 1 })
      .onConflictDoNothing()
      .returning({ revision: appSettings.revision });
    if (inserted.length === 0) conflict();
    return inserted[0].revision;
  }

  const updated = await db
    .update(appSettings)
    .set({
      valueEncrypted: null,
      revision: sql`${appSettings.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(appSettings.key, group), eq(appSettings.revision, expectedRevision)))
    .returning({ revision: appSettings.revision });
  if (updated.length === 0) conflict();
  return updated[0].revision;
}
