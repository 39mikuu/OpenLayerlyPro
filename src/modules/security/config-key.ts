import { readFileSync } from "fs";

import { getEnv } from "@/lib/env";

let cachedKey: string | null | undefined;

/**
 * 读取配置加密根密钥：
 * 1. 优先使用环境变量 CONFIG_ENCRYPTION_KEY；
 * 2. 否则读取 CONFIG_ENCRYPTION_KEY_FILE 指向的文件（Docker entrypoint 首次启动自动生成）；
 * 3. 两者均未配置时返回 null。
 *
 * 本轮只提供密钥读取能力，加密配置表在后续配置中心阶段实现。
 */
export function getConfigEncryptionKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const env = getEnv();

  if (env.CONFIG_ENCRYPTION_KEY) {
    cachedKey = env.CONFIG_ENCRYPTION_KEY;
    return cachedKey;
  }

  if (env.CONFIG_ENCRYPTION_KEY_FILE) {
    try {
      const content = readFileSync(env.CONFIG_ENCRYPTION_KEY_FILE, "utf8").trim();
      cachedKey = content.length > 0 ? content : null;
    } catch {
      // 不输出文件内容或路径细节，避免泄露敏感信息
      cachedKey = null;
    }
    return cachedKey;
  }

  cachedKey = null;
  return cachedKey;
}

/** 是否已配置任一密钥来源（env 或文件路径） */
export function isConfigEncryptionKeyConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.CONFIG_ENCRYPTION_KEY || env.CONFIG_ENCRYPTION_KEY_FILE);
}
