import { afterEach, describe, expect, it, vi } from "vitest";

const keys = ["EMAIL_RETRY_RECHECK_MINUTES", "EMAIL_DELIVERY_MAX_AGE_HOURS"] as const;
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
    });
  });

  it.each([
    ["EMAIL_RETRY_RECHECK_MINUTES", "1", 1],
    ["EMAIL_RETRY_RECHECK_MINUTES", "1440", 1440],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "1", 1],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "168", 168],
  ] as const)("accepts %s=%s", async (key, value, expected) => {
    await expect(load({ [key]: value })).resolves.toMatchObject({ [key]: expected });
  });

  it.each([
    ["EMAIL_RETRY_RECHECK_MINUTES", "0"],
    ["EMAIL_RETRY_RECHECK_MINUTES", "1441"],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "0"],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "169"],
    ["EMAIL_DELIVERY_MAX_AGE_HOURS", "1.5"],
  ] as const)("rejects invalid %s=%s", async (key, value) => {
    await expect(load({ [key]: value })).rejects.toThrow("环境变量配置错误");
  });
});
