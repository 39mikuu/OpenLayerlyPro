import { getEnv } from "@/lib/env";
import {
  resolveNotificationSecret,
  validateNotificationKeyPair,
} from "@/modules/security/notification-key-validation";

export type MagicLinkKey = {
  keyId: string;
  secret: string;
};

export type MagicLinkKeyring = {
  current: MagicLinkKey;
  previous: MagicLinkKey | null;
};

let cachedKeys: MagicLinkKeyring | null | undefined;

/**
 * Magic Link 登录 token 的哈希密钥环。与通知退订 keyring 同一套 current+previous
 * 语义:current 用于新 token 落库,previous 仅用于轮换窗口内验证旧 token。
 * 完全未配置时返回 null(登录页隐藏 Magic Link 入口);部分配置在 env 启动校验
 * 已 fail closed,这里不再重复报错路径。
 */
export function tryGetMagicLinkKeys(): MagicLinkKeyring | null {
  if (cachedKeys !== undefined) return cachedKeys;
  const env = getEnv();
  const hasAnyKeyConfig =
    env.MAGIC_LINK_KEY_ID ||
    env.MAGIC_LINK_SECRET ||
    env.MAGIC_LINK_SECRET_FILE ||
    env.MAGIC_LINK_PREVIOUS_KEY_ID ||
    env.MAGIC_LINK_PREVIOUS_SECRET ||
    env.MAGIC_LINK_PREVIOUS_SECRET_FILE;
  if (!hasAnyKeyConfig) {
    cachedKeys = null;
    return cachedKeys;
  }

  const currentSecret = resolveNotificationSecret(
    env.MAGIC_LINK_SECRET,
    env.MAGIC_LINK_SECRET_FILE,
    "MAGIC_LINK_SECRET",
  );
  const previousSecret = resolveNotificationSecret(
    env.MAGIC_LINK_PREVIOUS_SECRET,
    env.MAGIC_LINK_PREVIOUS_SECRET_FILE,
    "MAGIC_LINK_PREVIOUS_SECRET",
  );

  cachedKeys = validateNotificationKeyPair({
    currentKeyId: env.MAGIC_LINK_KEY_ID,
    currentSecret,
    currentKeyIdLabel: "MAGIC_LINK_KEY_ID",
    currentSecretLabel: "MAGIC_LINK_SECRET",
    previousKeyId: env.MAGIC_LINK_PREVIOUS_KEY_ID,
    previousSecret,
    previousKeyIdLabel: "MAGIC_LINK_PREVIOUS_KEY_ID",
    previousSecretLabel: "MAGIC_LINK_PREVIOUS_SECRET",
  });
  return cachedKeys;
}

export function getMagicLinkKeys(): MagicLinkKeyring {
  const keys = tryGetMagicLinkKeys();
  if (!keys) throw new Error("MAGIC_LINK_SECRET is missing or invalid");
  return keys;
}

export function resetMagicLinkKeyCacheForTests(): void {
  cachedKeys = undefined;
}
