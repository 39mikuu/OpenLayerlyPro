import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const keys = [
  "EMAIL_RETRY_RECHECK_MINUTES",
  "EMAIL_DELIVERY_MAX_AGE_HOURS",
  "TASK_TRANSACTIONAL_RESERVED_PER_BATCH",
  "TASK_NOTIFICATION_MIN_PER_BATCH",
  "TASK_DEFAULT_MIN_PER_BATCH",
  "TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH",
  "TASK_MAINTENANCE_MAX_PER_BATCH",
  "NOTIFICATION_EMAIL_DAILY_BUDGET",
  "NOTIFICATION_EMAIL_PACING_PER_MINUTE",
  "NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE",
  "NOTIFICATION_DELIVERY_MAX_AGE_HOURS",
  "NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS",
  "NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID",
  "NOTIFICATION_SUPPRESSION_DIGEST_SECRET",
  "NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE",
  "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID",
  "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET",
  "NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET_FILE",
  "NOTIFICATION_UNSUBSCRIBE_KEY_ID",
  "NOTIFICATION_UNSUBSCRIBE_SECRET",
  "NOTIFICATION_UNSUBSCRIBE_SECRET_FILE",
  "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID",
  "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET",
  "NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET_FILE",
  "MAGIC_LINK_KEY_ID",
  "MAGIC_LINK_SECRET",
  "MAGIC_LINK_SECRET_FILE",
  "MAGIC_LINK_PREVIOUS_KEY_ID",
  "MAGIC_LINK_PREVIOUS_SECRET",
  "MAGIC_LINK_PREVIOUS_SECRET_FILE",
] as const;
const originals = new Map(keys.map((key) => [key, process.env[key]]));
const originalNodeEnv = process.env.NODE_ENV;
const originalSessionSecret = process.env.SESSION_SECRET;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

async function load(overrides: Partial<Record<(typeof keys)[number], string>> = {}) {
  for (const key of keys) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, overrides, {
    NODE_ENV: "test",
    SESSION_SECRET: "email-delivery-env-test-secret-0123456789",
  });
  vi.resetModules();
  const { getEnv } = await import("./env");
  return getEnv();
}

afterEach(() => {
  for (const key of keys) restore(key, originals.get(key));
  restore("NODE_ENV", originalNodeEnv);
  restore("SESSION_SECRET", originalSessionSecret);
});

describe("email delivery retry environment", () => {
  it("uses the documented defaults", async () => {
    await expect(load()).resolves.toMatchObject({
      EMAIL_RETRY_RECHECK_MINUTES: 15,
      EMAIL_DELIVERY_MAX_AGE_HOURS: 24,
      TASK_TRANSACTIONAL_RESERVED_PER_BATCH: 8,
      TASK_NOTIFICATION_MIN_PER_BATCH: 2,
      TASK_DEFAULT_MIN_PER_BATCH: 2,
      TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH: 2,
      TASK_MAINTENANCE_MAX_PER_BATCH: 2,
      NOTIFICATION_EMAIL_DAILY_BUDGET: 500,
      NOTIFICATION_EMAIL_PACING_PER_MINUTE: 30,
      NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE: 500,
      NOTIFICATION_DELIVERY_MAX_AGE_HOURS: 168,
      NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS: 180,
    });
  });

  it.each([
    ["EMAIL_RETRY_RECHECK_MINUTES", "1", 1],
    ["EMAIL_RETRY_RECHECK_MINUTES", "1440", 1440],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "1", 1],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "168", 168],
    ["TASK_TRANSACTIONAL_RESERVED_PER_BATCH", "0", 0],
    ["TASK_TRANSACTIONAL_RESERVED_PER_BATCH", "20", 20],
    ["TASK_NOTIFICATION_MIN_PER_BATCH", "0", 0],
    ["TASK_NOTIFICATION_MIN_PER_BATCH", "20", 20],
    ["TASK_DEFAULT_MIN_PER_BATCH", "0", 0],
    ["TASK_DEFAULT_MIN_PER_BATCH", "20", 20],
    ["TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH", "0", 0],
    ["TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH", "20", 20],
    ["TASK_MAINTENANCE_MAX_PER_BATCH", "0", 0],
    ["TASK_MAINTENANCE_MAX_PER_BATCH", "20", 20],
    ["NOTIFICATION_EMAIL_DAILY_BUDGET", "1", 1],
    ["NOTIFICATION_EMAIL_DAILY_BUDGET", "100000", 100000],
    ["NOTIFICATION_EMAIL_PACING_PER_MINUTE", "1", 1],
    ["NOTIFICATION_EMAIL_PACING_PER_MINUTE", "10000", 10000],
    ["NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE", "1", 1],
    ["NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE", "5000", 5000],
    ["NOTIFICATION_DELIVERY_MAX_AGE_HOURS", "1", 1],
    ["NOTIFICATION_DELIVERY_MAX_AGE_HOURS", "720", 720],
    ["NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS", "1", 1],
    ["NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS", "3650", 3650],
  ] as const)("accepts %s=%s", async (key, value, expected) => {
    const overrides: Partial<Record<(typeof keys)[number], string>> = { [key]: value };
    if (
      key === "TASK_TRANSACTIONAL_RESERVED_PER_BATCH" ||
      key === "TASK_NOTIFICATION_MIN_PER_BATCH" ||
      key === "TASK_DEFAULT_MIN_PER_BATCH"
    ) {
      overrides.TASK_TRANSACTIONAL_RESERVED_PER_BATCH = "0";
      overrides.TASK_NOTIFICATION_MIN_PER_BATCH = "0";
      overrides.TASK_DEFAULT_MIN_PER_BATCH = "0";
      overrides[key] = value;
    }
    await expect(load(overrides)).resolves.toMatchObject({ [key]: expected });
  });

  it.each([
    ["EMAIL_RETRY_RECHECK_MINUTES", "0"],
    ["EMAIL_RETRY_RECHECK_MINUTES", "1441"],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "0"],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "169"],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "1.5"],
    ["TASK_TRANSACTIONAL_RESERVED_PER_BATCH", "-1"],
    ["TASK_TRANSACTIONAL_RESERVED_PER_BATCH", "21"],
    ["TASK_NOTIFICATION_MIN_PER_BATCH", "-1"],
    ["TASK_NOTIFICATION_MIN_PER_BATCH", "21"],
    ["TASK_DEFAULT_MIN_PER_BATCH", "-1"],
    ["TASK_DEFAULT_MIN_PER_BATCH", "21"],
    ["TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH", "-1"],
    ["TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH", "21"],
    ["TASK_MAINTENANCE_MAX_PER_BATCH", "-1"],
    ["TASK_MAINTENANCE_MAX_PER_BATCH", "21"],
    ["NOTIFICATION_EMAIL_DAILY_BUDGET", "0"],
    ["NOTIFICATION_EMAIL_DAILY_BUDGET", "100001"],
    ["NOTIFICATION_EMAIL_PACING_PER_MINUTE", "0"],
    ["NOTIFICATION_EMAIL_PACING_PER_MINUTE", "10001"],
    ["NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE", "0"],
    ["NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE", "5001"],
    ["NOTIFICATION_DELIVERY_MAX_AGE_HOURS", "0"],
    ["NOTIFICATION_DELIVERY_MAX_AGE_HOURS", "721"],
    ["NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS", "0"],
    ["NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS", "3651"],
  ] as const)("rejects invalid %s=%s", async (key, value) => {
    await expect(load({ [key]: value })).rejects.toThrow("环境变量配置错误");
  });

  it("rejects queue class minimums that exceed the batch size together", async () => {
    await expect(
      load({
        TASK_TRANSACTIONAL_RESERVED_PER_BATCH: "17",
        TASK_NOTIFICATION_MIN_PER_BATCH: "2",
        TASK_DEFAULT_MIN_PER_BATCH: "2",
      }),
    ).rejects.toThrow(
      "TASK_TRANSACTIONAL_RESERVED_PER_BATCH + TASK_NOTIFICATION_MIN_PER_BATCH + TASK_DEFAULT_MIN_PER_BATCH must be <= TASK_BATCH_SIZE",
    );
  });
});

describe("notification key startup validation", () => {
  const validSecret = "0123456789abcdef0123456789abcdef";
  let previousSecretFile: string;

  beforeAll(() => {
    previousSecretFile = join(mkdtempSync(join(tmpdir(), "env-key-test-")), "previous-secret");
    writeFileSync(previousSecretFile, validSecret, { mode: 0o600 });
  });

  it("allows a fully unconfigured key family", async () => {
    await expect(load()).resolves.toBeTruthy();
  });

  it.each([
    ["unsubscribe previous key id only", { NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID: "old" }],
    ["unsubscribe previous secret only", { NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET: validSecret }],
    [
      "unsubscribe previous id + secret without current",
      {
        NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID: "old",
        NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET: validSecret,
      },
    ],
    [
      "suppression previous key id only",
      { NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID: "old" },
    ],
    [
      "suppression previous secret only",
      { NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET: validSecret },
    ],
    [
      "suppression previous id + secret without current",
      {
        NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID: "old",
        NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET: validSecret,
      },
    ],
    ["magic link previous key id only", { MAGIC_LINK_PREVIOUS_KEY_ID: "old" }],
    ["magic link previous secret only", { MAGIC_LINK_PREVIOUS_SECRET: validSecret }],
    [
      "magic link previous id + secret without current",
      {
        MAGIC_LINK_PREVIOUS_KEY_ID: "old",
        MAGIC_LINK_PREVIOUS_SECRET: validSecret,
      },
    ],
    ["magic link secret without key id", { MAGIC_LINK_SECRET: validSecret }],
  ] as const)("fails closed at startup for %s", async (_name, overrides) => {
    await expect(load({ ...overrides })).rejects.toThrow("is missing or invalid");
  });

  it("fails closed for unsubscribe previous secret file only", async () => {
    await expect(
      load({ NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET_FILE: previousSecretFile }),
    ).rejects.toThrow("is missing or invalid");
  });

  it("fails closed for suppression previous secret file only", async () => {
    await expect(
      load({ NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET_FILE: previousSecretFile }),
    ).rejects.toThrow("is missing or invalid");
  });

  it("accepts a complete magic link current+previous keyring", async () => {
    await expect(
      load({
        MAGIC_LINK_KEY_ID: "k2",
        MAGIC_LINK_SECRET: validSecret,
        MAGIC_LINK_PREVIOUS_KEY_ID: "k1",
        MAGIC_LINK_PREVIOUS_SECRET_FILE: previousSecretFile,
      }),
    ).resolves.toMatchObject({ MAGIC_LINK_KEY_ID: "k2" });
  });
});
