import { afterEach, describe, expect, it, vi } from "vitest";

const keys = [
  "EMAIL_RETRY_RECHECK_MINUTES",
  "EMAIL_DELIVERY_MAX_AGE_HOURS",
  "TASK_TRANSACTIONAL_RESERVED_PER_BATCH",
  "TASK_NOTIFICATION_MIN_PER_BATCH",
  "TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH",
  "TASK_MAINTENANCE_MAX_PER_BATCH",
  "NOTIFICATION_EMAIL_DAILY_BUDGET",
  "NOTIFICATION_EMAIL_PACING_PER_MINUTE",
  "NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE",
  "NOTIFICATION_DELIVERY_MAX_AGE_HOURS",
  "NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS",
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
    await expect(load({ [key]: value })).resolves.toMatchObject({ [key]: expected });
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
});
