import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const managedEnv = [
  "NODE_ENV",
  "SESSION_SECRET",
  "NOTIFICATION_UNSUBSCRIBE_KEY_ID",
  "NOTIFICATION_UNSUBSCRIBE_SECRET",
  "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID",
  "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET",
  "NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS",
] as const;
const originals = new Map(managedEnv.map((key) => [key, process.env[key]]));
const currentSecret = "unsubscribe-secret-0123456789012345";
const previousSecret = "unsubscribe-previous-secret-0123456789";

const mocks = vi.hoisted(() => ({
  usersRows: [{ id: "11111111-1111-4111-8111-111111111111" }],
  preferenceRows: [{ version: 3, newPostEmailEnabled: true }],
  timingSafeEqual: vi.fn((left: Buffer, right: Buffer) => left.equals(right)),
  selectCall: 0,
}));

vi.mock("crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("crypto")>();
  return {
    ...original,
    timingSafeEqual: mocks.timingSafeEqual,
  };
});

function selectBuilder(rows: unknown[]) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  return builder;
}

vi.mock("@/db", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => {
      const rows = mocks.selectCall % 2 === 0 ? mocks.usersRows : mocks.preferenceRows;
      mocks.selectCall += 1;
      return selectBuilder(rows);
    }),
  })),
}));

function restoreEnv(): void {
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of originals) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else env[key] = value;
  }
}

beforeEach(() => {
  mocks.usersRows = [{ id: "11111111-1111-4111-8111-111111111111" }];
  mocks.preferenceRows = [{ version: 3, newPostEmailEnabled: true }];
  mocks.selectCall = 0;
  mocks.timingSafeEqual.mockClear();
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "unsubscribe-token-test-session-secret",
    NOTIFICATION_UNSUBSCRIBE_KEY_ID: "kid-current",
    NOTIFICATION_UNSUBSCRIBE_SECRET: currentSecret,
    NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID: "kid-previous",
    NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET: previousSecret,
    NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS: "180",
  });
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("notification unsubscribe token generation", () => {
  it("uses the approved prefix, key id, payload shape, and purpose-separated HMAC", async () => {
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
    const expectedMac = createHmac("sha256", currentSecret)
      .update("notification.unsubscribe:v1")
      .update("\0")
      .update(signingInput)
      .digest("hex");
    expect(parts[4]).toBe(expectedMac);
  });
});

describe("notification unsubscribe token verification", () => {
  it("accepts a current-key token when user, version, and enabled preference match", async () => {
    vi.resetModules();
    const { generateNotificationUnsubscribeToken, verifyNotificationUnsubscribeToken } =
      await import("./unsubscribe-token");
    const token = generateNotificationUnsubscribeToken({
      userId: "11111111-1111-4111-8111-111111111111",
      preferenceVersion: 3,
      issuedAt: new Date("2026-07-12T00:00:00.000Z"),
    });

    await expect(
      verifyNotificationUnsubscribeToken(token, { now: new Date("2026-07-13T00:00:00.000Z") }),
    ).resolves.toMatchObject({ valid: true, keyId: "kid-current" });
  });

  it("accepts a previous-key token during rotation", async () => {
    process.env.NOTIFICATION_UNSUBSCRIBE_KEY_ID = "kid-previous";
    process.env.NOTIFICATION_UNSUBSCRIBE_SECRET = previousSecret;
    Reflect.deleteProperty(process.env, "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID");
    Reflect.deleteProperty(process.env, "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET");
    vi.resetModules();
    const { generateNotificationUnsubscribeToken } = await import("./unsubscribe-token");
    const token = generateNotificationUnsubscribeToken({
      userId: "11111111-1111-4111-8111-111111111111",
      preferenceVersion: 3,
      issuedAt: new Date("2026-07-12T00:00:00.000Z"),
    });

    process.env.NOTIFICATION_UNSUBSCRIBE_KEY_ID = "kid-current";
    process.env.NOTIFICATION_UNSUBSCRIBE_SECRET = currentSecret;
    process.env.NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID = "kid-previous";
    process.env.NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET = previousSecret;
    vi.resetModules();
    const { verifyNotificationUnsubscribeToken } = await import("./unsubscribe-token");

    await expect(
      verifyNotificationUnsubscribeToken(token, { now: new Date("2026-07-13T00:00:00.000Z") }),
    ).resolves.toMatchObject({ valid: true, keyId: "kid-previous" });
  });

  it.each([
    [
      "unknown kid",
      (token: string) => token.replace(".kid-current.", ".kid-unknown."),
      "unknown-key",
    ],
    ["expired age", (token: string) => token, "expired", new Date("2027-02-01T00:00:00.000Z")],
    ["wrong version", (token: string) => token, "version-mismatch"],
    ["disabled preference", (token: string) => token, "preference-disabled"],
  ] as const)(
    "rejects %s",
    async (_label, mutate, reason, now = new Date("2026-07-13T00:00:00.000Z")) => {
      if (reason === "version-mismatch") {
        mocks.preferenceRows = [{ version: 4, newPostEmailEnabled: true }];
      }
      if (reason === "preference-disabled") {
        mocks.preferenceRows = [{ version: 3, newPostEmailEnabled: false }];
      }
      vi.resetModules();
      const { generateNotificationUnsubscribeToken, verifyNotificationUnsubscribeToken } =
        await import("./unsubscribe-token");
      const token = generateNotificationUnsubscribeToken({
        userId: "11111111-1111-4111-8111-111111111111",
        preferenceVersion: 3,
        issuedAt: new Date("2026-07-12T00:00:00.000Z"),
      });

      await expect(
        verifyNotificationUnsubscribeToken(mutate(token), { now }),
      ).resolves.toMatchObject({
        valid: false,
        reason,
      });
    },
  );

  it("rejects missing users", async () => {
    mocks.usersRows = [];
    vi.resetModules();
    const { generateNotificationUnsubscribeToken, verifyNotificationUnsubscribeToken } =
      await import("./unsubscribe-token");
    const token = generateNotificationUnsubscribeToken({
      userId: "11111111-1111-4111-8111-111111111111",
      preferenceVersion: 3,
      issuedAt: new Date("2026-07-12T00:00:00.000Z"),
    });

    await expect(
      verifyNotificationUnsubscribeToken(token, { now: new Date("2026-07-13T00:00:00.000Z") }),
    ).resolves.toMatchObject({ valid: false, reason: "user-missing" });
  });

  it("rejects tampered MACs while still using the constant-time compare path", async () => {
    vi.resetModules();
    const { generateNotificationUnsubscribeToken, verifyNotificationUnsubscribeToken } =
      await import("./unsubscribe-token");
    const token = generateNotificationUnsubscribeToken({
      userId: "11111111-1111-4111-8111-111111111111",
      preferenceVersion: 3,
      issuedAt: new Date("2026-07-12T00:00:00.000Z"),
    });
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;

    await expect(
      verifyNotificationUnsubscribeToken(tampered, {
        now: new Date("2026-07-13T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ valid: false, reason: "bad-mac" });
    expect(mocks.timingSafeEqual).toHaveBeenCalled();
  });
});
