import { afterEach, describe, expect, it, vi } from "vitest";

const key = "SUBSCRIPTION_REMINDER_LEAD_DAYS";
const originalValue = process.env[key];
const originalNodeEnv = process.env.NODE_ENV;
const originalSessionSecret = process.env.SESSION_SECRET;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

async function load(value?: string) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "subscription-reminder-env-test-secret-0123456789",
  });
  vi.resetModules();
  const { getEnv } = await import("./env");
  return getEnv();
}

afterEach(() => {
  restore(key, originalValue);
  restore("NODE_ENV", originalNodeEnv);
  restore("SESSION_SECRET", originalSessionSecret);
});

describe("subscription reminder lead days", () => {
  it("defaults to seven days", async () => {
    await expect(load()).resolves.toMatchObject({ SUBSCRIPTION_REMINDER_LEAD_DAYS: 7 });
  });

  it.each(["1", "90"])("accepts boundary value %s", async (value) => {
    await expect(load(value)).resolves.toMatchObject({
      SUBSCRIPTION_REMINDER_LEAD_DAYS: Number(value),
    });
  });

  it.each(["0", "91", "1.5", "NaN", "Infinity"])(
    "rejects out-of-range or non-finite value %s instead of clamping",
    async (value) => {
      await expect(load(value)).rejects.toThrow("环境变量配置错误");
    },
  );
});
