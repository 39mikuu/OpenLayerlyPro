import { closeSync, constants, fstatSync, openSync, readFileSync } from "fs";

export const MIN_NOTIFICATION_SECRET_LENGTH = 32;
export const NOTIFICATION_KEY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

type NotificationKeyMaterial = {
  keyId: string;
  secret: string;
};

type NotificationKeyPair = {
  current: NotificationKeyMaterial;
  previous: NotificationKeyMaterial | null;
};

export function invalidNotificationKey(label: string): never {
  throw new Error(`${label} is missing or invalid`);
}

export function validateNotificationSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length < MIN_NOTIFICATION_SECRET_LENGTH ||
    trimmed === "change-me" ||
    value.length === 0
  ) {
    invalidNotificationKey(label);
  }
  return trimmed;
}

export function normalizeNotificationKeyId(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed || !NOTIFICATION_KEY_ID_PATTERN.test(trimmed)) invalidNotificationKey(label);
  return trimmed;
}

export function readNotificationSecretFile(path: string, label: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      invalidNotificationKey(label);
    }
    throw new Error(`${label} is unreadable`);
  }

  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) invalidNotificationKey(label);
    return validateNotificationSecret(readFileSync(descriptor, "utf8"), label);
  } finally {
    closeSync(descriptor);
  }
}

export function resolveNotificationSecret(
  envSecret: string | undefined,
  filePath: string | undefined,
  label: string,
): string | null {
  if (envSecret !== undefined && envSecret.length > 0) {
    return validateNotificationSecret(envSecret, label);
  }
  if (filePath) return readNotificationSecretFile(filePath, label);
  return null;
}

export function validateNotificationKeyPair(input: {
  currentKeyId: string | undefined;
  currentSecret: string | null;
  currentKeyIdLabel: string;
  currentSecretLabel: string;
  previousKeyId: string | undefined;
  previousSecret: string | null;
  previousKeyIdLabel: string;
  previousSecretLabel: string;
}): NotificationKeyPair {
  const currentSecret = input.currentSecret;
  if (!currentSecret) invalidNotificationKey(input.currentSecretLabel);
  const current = {
    keyId: normalizeNotificationKeyId(input.currentKeyId, input.currentKeyIdLabel),
    secret: currentSecret,
  };

  const hasPreviousKeyId = Boolean(input.previousKeyId?.trim());
  const previousSecret = input.previousSecret;
  const hasPreviousSecret = previousSecret !== null;
  if (hasPreviousKeyId !== hasPreviousSecret) {
    invalidNotificationKey(hasPreviousKeyId ? input.previousSecretLabel : input.previousKeyIdLabel);
  }
  if (!hasPreviousSecret) return { current, previous: null };

  const previous = {
    keyId: normalizeNotificationKeyId(input.previousKeyId, input.previousKeyIdLabel),
    secret: previousSecret,
  };
  if (previous.keyId === current.keyId) invalidNotificationKey(input.previousKeyIdLabel);
  return { current, previous };
}
