import { createHmac } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const managedEnv = [
  "NODE_ENV",
  "SESSION_SECRET",
  "NOTIFICATION_UNSUBSCRIBE_KEY_ID",
  "NOTIFICATION_UNSUBSCRIBE_SECRET",
] as const;
const originals = new Map(managedEnv.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of originals) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("notification unsubscribe token generation", () => {
  it("uses the approved prefix, key id, payload shape, and purpose-separated HMAC", async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      SESSION_SECRET: "unsubscribe-token-test-session-secret",
      NOTIFICATION_UNSUBSCRIBE_KEY_ID: "kid-current",
      NOTIFICATION_UNSUBSCRIBE_SECRET: "unsubscribe-secret",
    });
    vi.resetModules();
    const { generateNotificationUnsubscribeToken } = await import("./unsubscribe-token");

    const token = generateNotificationUnsubscribeToken({
      userId: "11111111-1111-4111-8111-111111111111",
      preferenceVersion: 3,
      issuedAt: new Date("2026-07-12T00:00:00.000Z"),
    });

    const parts = token.split(".");
    expect(parts).toHaveLength(5);
    expect(parts.slice(0, 3)).toEqual(["olp_npu", "v1", "kid-current"]);
    const payload = JSON.parse(Buffer.from(parts[3]!, "base64url").toString("utf8"));
    expect(payload).toEqual({
      purpose: "notification.unsubscribe",
      version: 1,
      userId: "11111111-1111-4111-8111-111111111111",
      preferenceVersion: 3,
      issuedAt: "2026-07-12T00:00:00.000Z",
    });

    const signingInput = parts.slice(0, 4).join(".");
    const expectedMac = createHmac("sha256", "unsubscribe-secret")
      .update("notification.unsubscribe:v1")
      .update("\0")
      .update(signingInput)
      .digest("hex");
    expect(parts[4]).toBe(expectedMac);
  });
});
