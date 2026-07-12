import { createHmac } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const managedEnv = [
  "NODE_ENV",
  "SESSION_SECRET",
  "NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID",
  "NOTIFICATION_SUPPRESSION_DIGEST_SECRET",
  "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID",
  "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET",
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

describe("notification suppression digest key", () => {
  it("uses a dedicated purpose-separated key instead of SESSION_SECRET", async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      SESSION_SECRET: "different-session-secret",
      NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID: "supp-current",
      NOTIFICATION_SUPPRESSION_DIGEST_SECRET: "suppression-secret",
    });
    vi.resetModules();
    const { createNotificationSuppressionDigest } = await import("./notification-suppression-key");

    const digest = createNotificationSuppressionDigest(" Fan@Example.COM ");
    const expected = createHmac("sha256", "suppression-secret")
      .update("notification.suppression-email:v1")
      .update("\0")
      .update("fan@example.com")
      .digest("hex");
    const sessionBacked = createHmac("sha256", "different-session-secret")
      .update("notification.suppression-email:v1")
      .update("\0")
      .update("fan@example.com")
      .digest("hex");

    expect(digest).toEqual({ keyId: "supp-current", digest: expected });
    expect(digest.digest).not.toBe(sessionBacked);
  });

  it("returns current and previous digest candidates for matching old suppressions", async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      SESSION_SECRET: "session-secret",
      NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID: "current",
      NOTIFICATION_SUPPRESSION_DIGEST_SECRET: "current-secret",
      NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID: "previous",
      NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET: "previous-secret",
    });
    vi.resetModules();
    const { createNotificationSuppressionDigestCandidates } =
      await import("./notification-suppression-key");

    expect(
      createNotificationSuppressionDigestCandidates("fan@example.com").map((row) => row.keyId),
    ).toEqual(["current", "previous"]);
  });
});
