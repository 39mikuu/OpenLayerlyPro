import { closeSync, constants, fstatSync, openSync, readFileSync } from "fs";

import { getEnv } from "@/lib/env";

let cachedKey: string | null | undefined;

function invalidConfigEncryptionKey(): never {
  throw new Error("CONFIG_ENCRYPTION_KEY is missing or invalid");
}

function invalidConfigEncryptionKeyFile(): never {
  throw new Error("CONFIG_ENCRYPTION_KEY_FILE is missing or invalid");
}

function validateConfigEncryptionKey(value: string): string {
  if (value.length === 0 || value.trim().length === 0) invalidConfigEncryptionKey();
  return value;
}

function normalizeConfigEncryptionKeyFileContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) invalidConfigEncryptionKeyFile();
  // File-backed key reads intentionally match origin/main's `.trim()` semantics.
  // Generated cek1 files contain no surrounding whitespace, so this is identity for them.
  return trimmed;
}

function readConfigEncryptionKeyFile(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      invalidConfigEncryptionKeyFile();
    }
    throw new Error("CONFIG_ENCRYPTION_KEY_FILE is unreadable");
  }

  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) invalidConfigEncryptionKeyFile();
    return normalizeConfigEncryptionKeyFileContent(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}

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

  if (env.CONFIG_ENCRYPTION_KEY !== undefined && env.CONFIG_ENCRYPTION_KEY.length > 0) {
    cachedKey = validateConfigEncryptionKey(env.CONFIG_ENCRYPTION_KEY);
    return cachedKey;
  }

  if (env.CONFIG_ENCRYPTION_KEY_FILE) {
    cachedKey = readConfigEncryptionKeyFile(env.CONFIG_ENCRYPTION_KEY_FILE);
    return cachedKey;
  }

  cachedKey = null;
  return cachedKey;
}

/** 是否已配置任一密钥来源（env 或文件路径） */
export function isConfigEncryptionKeyConfigured(): boolean {
  const env = getEnv();
  return Boolean(
    (env.CONFIG_ENCRYPTION_KEY !== undefined && env.CONFIG_ENCRYPTION_KEY.length > 0) ||
    env.CONFIG_ENCRYPTION_KEY_FILE,
  );
}

export function resetConfigEncryptionKeyCacheForTests(): void {
  cachedKey = undefined;
}
