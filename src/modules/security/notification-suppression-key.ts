import { createHmac, timingSafeEqual } from "crypto";

import { getEnv } from "@/lib/env";
import {
  resolveNotificationSecret,
  validateNotificationKeyPair,
} from "@/modules/security/notification-key-validation";

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

export function normalizeEmailForNotificationSuppression(email: string): string {
  return email.trim().toLowerCase();
}

export function getNotificationSuppressionDigestKeys(): {
  current: KeyMaterial;
  previous: KeyMaterial | null;
} {
  if (cachedKeys) return cachedKeys;
  const env = getEnv();
  const currentSecret = resolveNotificationSecret(
    env.NOTIFICATION_SUPPRESSION_DIGEST_SECRET,
    env.NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE,
    "NOTIFICATION_SUPPRESSION_DIGEST_SECRET",
  );
  const previousSecret = resolveNotificationSecret(
    env.NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET,
    env.NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET_FILE,
    "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET",
  );

  cachedKeys = validateNotificationKeyPair({
    currentKeyId: env.NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID,
    currentSecret,
    currentKeyIdLabel: "NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID",
    currentSecretLabel: "NOTIFICATION_SUPPRESSION_DIGEST_SECRET",
    previousKeyId: env.NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID,
    previousSecret,
    previousKeyIdLabel: "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID",
    previousSecretLabel: "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET",
  });
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
