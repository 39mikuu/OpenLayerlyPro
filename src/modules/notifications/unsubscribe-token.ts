import { createHmac } from "crypto";

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
