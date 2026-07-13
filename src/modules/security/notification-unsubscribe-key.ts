import { getEnv } from "@/lib/env";
import {
  resolveNotificationSecret,
  validateNotificationKeyPair,
} from "@/modules/security/notification-key-validation";

export type NotificationUnsubscribeKey = {
  keyId: string;
  secret: string;
};

let cachedKeys:
  | { current: NotificationUnsubscribeKey; previous: NotificationUnsubscribeKey | null }
  | undefined;

export function getNotificationUnsubscribeKeys(): {
  current: NotificationUnsubscribeKey;
  previous: NotificationUnsubscribeKey | null;
} {
  if (cachedKeys) return cachedKeys;
  const env = getEnv();
  const currentSecret = resolveNotificationSecret(
    env.NOTIFICATION_UNSUBSCRIBE_SECRET,
    env.NOTIFICATION_UNSUBSCRIBE_SECRET_FILE,
    "NOTIFICATION_UNSUBSCRIBE_SECRET",
  );
  const previousSecret = resolveNotificationSecret(
    env.NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET,
    env.NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET_FILE,
    "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET",
  );

  cachedKeys = validateNotificationKeyPair({
    currentKeyId: env.NOTIFICATION_UNSUBSCRIBE_KEY_ID,
    currentSecret,
    currentKeyIdLabel: "NOTIFICATION_UNSUBSCRIBE_KEY_ID",
    currentSecretLabel: "NOTIFICATION_UNSUBSCRIBE_SECRET",
    previousKeyId: env.NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID,
    previousSecret,
    previousKeyIdLabel: "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID",
    previousSecretLabel: "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET",
  });
  return cachedKeys;
}

export function resetNotificationUnsubscribeKeyCacheForTests(): void {
  cachedKeys = undefined;
}
