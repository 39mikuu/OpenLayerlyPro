import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * 加密配置存储:每个「配置组」(如 smtp)以一行存储,value 为整组配置 JSON 的
 * AES-256-GCM 密文。读取时解密并 JSON.parse,无记录返回 null;解密/解析失败抛错,
 * 不静默吞掉(便于在密钥错误或数据损坏时尽早暴露)。
 */
export async function getStoredGroup<T>(group: string): Promise<Partial<T> | null> {
  const [row] = await getDb().select().from(appSettings).where(eq(appSettings.key, group)).limit(1);
  if (!row) return null;
  return JSON.parse(decryptSecret(row.valueEncrypted)) as Partial<T>;
}

export async function setStoredGroup<T>(group: string, value: Partial<T>): Promise<void> {
  const valueEncrypted = encryptSecret(JSON.stringify(value));
  await getDb()
    .insert(appSettings)
    .values({ key: group, valueEncrypted })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { valueEncrypted, updatedAt: new Date() },
    });
}

/** 删除某配置组,使其回落到环境变量/默认值。 */
export async function deleteStoredGroup(group: string): Promise<void> {
  await getDb().delete(appSettings).where(eq(appSettings.key, group));
}
