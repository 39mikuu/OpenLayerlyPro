import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { notificationPreferences, users } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getNotificationUnsubscribeKeys } from "@/modules/security/notification-unsubscribe-key";

const TOKEN_PREFIX = "olp_npu";
const TOKEN_VERSION = "v1";
const TOKEN_PURPOSE = "notification.unsubscribe";
const MAC_PURPOSE = "notification.unsubscribe:v1";

export type NotificationUnsubscribeTokenPayload = {
  purpose: typeof TOKEN_PURPOSE;
  version: 1;
  userId: string;
  preferenceVersion: number;
  issuedAt: string;
};

function base64UrlJson(payload: NotificationUnsubscribeTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function sign(input: string, secret: string): string {
  return createHmac("sha256", secret).update(MAC_PURPOSE).update("\0").update(input).digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    const paddedRight = Buffer.alloc(leftBuffer.length);
    timingSafeEqual(leftBuffer, paddedRight);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePayload(encoded: string): NotificationUnsubscribeTokenPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.purpose !== TOKEN_PURPOSE ||
      parsed.version !== 1 ||
      typeof parsed.userId !== "string" ||
      typeof parsed.preferenceVersion !== "number" ||
      !Number.isInteger(parsed.preferenceVersion) ||
      parsed.preferenceVersion < 0 ||
      typeof parsed.issuedAt !== "string"
    ) {
      return null;
    }
    const issuedAt = new Date(parsed.issuedAt);
    if (Number.isNaN(issuedAt.getTime())) return null;
    return parsed as NotificationUnsubscribeTokenPayload;
  } catch {
    return null;
  }
}

export function generateNotificationUnsubscribeToken(input: {
  userId: string;
  preferenceVersion: number;
  issuedAt?: Date;
}): string {
  const key = getNotificationUnsubscribeKeys().current;
  const payload = base64UrlJson({
    purpose: TOKEN_PURPOSE,
    version: 1,
    userId: input.userId,
    preferenceVersion: input.preferenceVersion,
    issuedAt: (input.issuedAt ?? new Date()).toISOString(),
  });
  const signingInput = [TOKEN_PREFIX, TOKEN_VERSION, key.keyId, payload].join(".");
  return `${signingInput}.${sign(signingInput, key.secret)}`;
}

export type NotificationUnsubscribeVerification =
  | {
      valid: true;
      payload: NotificationUnsubscribeTokenPayload;
      keyId: string;
    }
  | {
      valid: false;
      reason:
        | "malformed"
        | "unknown-key"
        | "bad-mac"
        | "expired"
        | "user-missing"
        | "preference-missing"
        | "version-mismatch"
        | "preference-disabled";
      payload?: NotificationUnsubscribeTokenPayload;
      keyId?: string;
    };

export async function verifyNotificationUnsubscribeToken(
  token: string,
  options: { now?: Date } = {},
): Promise<NotificationUnsubscribeVerification> {
  const parts = token.split(".");
  if (parts.length !== 5) return { valid: false, reason: "malformed" };
  const [prefix, version, kid, payloadEncoded, macHex] = parts;
  if (
    prefix !== TOKEN_PREFIX ||
    version !== TOKEN_VERSION ||
    !kid ||
    !payloadEncoded ||
    !macHex ||
    !/^[0-9a-f]{64}$/i.test(macHex)
  ) {
    return { valid: false, reason: "malformed" };
  }

  const payload = parsePayload(payloadEncoded);
  if (!payload) return { valid: false, reason: "malformed", keyId: kid };

  const keys = getNotificationUnsubscribeKeys();
  const key = [keys.current, keys.previous].find((candidate) => candidate?.keyId === kid);
  const signingInput = [TOKEN_PREFIX, TOKEN_VERSION, kid, payloadEncoded].join(".");
  const expectedMac = key ? sign(signingInput, key.secret) : "0".repeat(64);
  const macOk = safeEqualHex(expectedMac, macHex);
  if (!key) return { valid: false, reason: "unknown-key", payload, keyId: kid };
  if (!macOk) return { valid: false, reason: "bad-mac", payload, keyId: kid };

  const issuedAt = new Date(payload.issuedAt);
  const now = options.now ?? new Date();
  const maxAgeMs = getEnv().NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
  if (now.getTime() < issuedAt.getTime() || now.getTime() - issuedAt.getTime() > maxAgeMs) {
    return { valid: false, reason: "expired", payload, keyId: kid };
  }

  const [user] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);
  if (!user) return { valid: false, reason: "user-missing", payload, keyId: kid };

  const [preference] = await getDb()
    .select({
      version: notificationPreferences.version,
      newPostEmailEnabled: notificationPreferences.newPostEmailEnabled,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, payload.userId))
    .limit(1);
  if (!preference) return { valid: false, reason: "preference-missing", payload, keyId: kid };
  if (preference.version !== payload.preferenceVersion) {
    return { valid: false, reason: "version-mismatch", payload, keyId: kid };
  }
  if (!preference.newPostEmailEnabled) {
    return { valid: false, reason: "preference-disabled", payload, keyId: kid };
  }

  return { valid: true, payload, keyId: kid };
}
