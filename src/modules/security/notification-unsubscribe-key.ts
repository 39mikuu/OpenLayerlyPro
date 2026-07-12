import { closeSync, constants, fstatSync, openSync, readFileSync } from "fs";

import { getEnv } from "@/lib/env";

export type NotificationUnsubscribeKey = {
  keyId: string;
  secret: string;
};

let cachedKeys:
  | { current: NotificationUnsubscribeKey; previous: NotificationUnsubscribeKey | null }
  | undefined;

function invalidKey(message: string): never {
  throw new Error(message);
}

function normalizeSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) invalidKey(`${label} is missing or invalid`);
  return trimmed;
}

function readSecretFile(path: string, label: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      invalidKey(`${label} is missing or invalid`);
    }
    throw new Error(`${label} is unreadable`);
  }

  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) invalidKey(`${label} is missing or invalid`);
    return normalizeSecret(readFileSync(descriptor, "utf8"), label);
  } finally {
    closeSync(descriptor);
  }
}

function resolveSecret(
  envSecret: string | undefined,
  filePath: string | undefined,
  label: string,
): string | null {
  if (envSecret !== undefined && envSecret.length > 0) return normalizeSecret(envSecret, label);
  if (filePath) return readSecretFile(filePath, label);
  return null;
}

function normalizeKeyId(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) invalidKey(`${label} is missing or invalid`);
  return trimmed;
}

export function getNotificationUnsubscribeKeys(): {
  current: NotificationUnsubscribeKey;
  previous: NotificationUnsubscribeKey | null;
} {
  if (cachedKeys) return cachedKeys;
  const env = getEnv();
  const currentSecret = resolveSecret(
    env.NOTIFICATION_UNSUBSCRIBE_SECRET,
    env.NOTIFICATION_UNSUBSCRIBE_SECRET_FILE,
    "NOTIFICATION_UNSUBSCRIBE_SECRET",
  );
  if (!currentSecret) invalidKey("NOTIFICATION_UNSUBSCRIBE_SECRET is missing or invalid");

  const previousSecret = resolveSecret(
    env.NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET,
    env.NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET_FILE,
    "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET",
  );

  cachedKeys = {
    current: {
      keyId: normalizeKeyId(env.NOTIFICATION_UNSUBSCRIBE_KEY_ID, "NOTIFICATION_UNSUBSCRIBE_KEY_ID"),
      secret: currentSecret,
    },
    previous: previousSecret
      ? {
          keyId: normalizeKeyId(
            env.NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID,
            "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID",
          ),
          secret: previousSecret,
        }
      : null,
  };
  return cachedKeys;
}

export function resetNotificationUnsubscribeKeyCacheForTests(): void {
  cachedKeys = undefined;
}
