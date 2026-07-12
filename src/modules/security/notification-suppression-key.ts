import { createHmac, timingSafeEqual } from "crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "fs";

import { getEnv } from "@/lib/env";

export const NOTIFICATION_SUPPRESSION_DIGEST_PURPOSE = "notification.suppression-email:v1";

export type NotificationSuppressionDigest = {
  keyId: string;
  digest: string;
};

type KeyMaterial = {
  keyId: string;
  secret: string;
};

let cachedKeys: { current: KeyMaterial; previous: KeyMaterial | null } | undefined;

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

export function normalizeEmailForNotificationSuppression(email: string): string {
  return email.trim().toLowerCase();
}

export function getNotificationSuppressionDigestKeys(): {
  current: KeyMaterial;
  previous: KeyMaterial | null;
} {
  if (cachedKeys) return cachedKeys;
  const env = getEnv();
  const currentSecret = resolveSecret(
    env.NOTIFICATION_SUPPRESSION_DIGEST_SECRET,
    env.NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE,
    "NOTIFICATION_SUPPRESSION_DIGEST_SECRET",
  );
  if (!currentSecret) invalidKey("NOTIFICATION_SUPPRESSION_DIGEST_SECRET is missing or invalid");

  const previousSecret = resolveSecret(
    env.NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET,
    env.NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET_FILE,
    "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET",
  );

  cachedKeys = {
    current: {
      keyId: normalizeKeyId(
        env.NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID,
        "NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID",
      ),
      secret: currentSecret,
    },
    previous: previousSecret
      ? {
          keyId: normalizeKeyId(
            env.NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID,
            "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID",
          ),
          secret: previousSecret,
        }
      : null,
  };
  return cachedKeys;
}

function digestWithKey(email: string, key: KeyMaterial): NotificationSuppressionDigest {
  return {
    keyId: key.keyId,
    digest: createHmac("sha256", key.secret)
      .update(NOTIFICATION_SUPPRESSION_DIGEST_PURPOSE)
      .update("\0")
      .update(normalizeEmailForNotificationSuppression(email))
      .digest("hex"),
  };
}

export function createNotificationSuppressionDigest(email: string): NotificationSuppressionDigest {
  return digestWithKey(email, getNotificationSuppressionDigestKeys().current);
}

export function createNotificationSuppressionDigestCandidates(
  email: string,
): NotificationSuppressionDigest[] {
  const keys = getNotificationSuppressionDigestKeys();
  return [keys.current, keys.previous]
    .filter((key): key is KeyMaterial => key !== null)
    .map((key) => digestWithKey(email, key));
}

export function safeEqualNotificationSuppressionDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function resetNotificationSuppressionDigestKeyCacheForTests(): void {
  cachedKeys = undefined;
}
