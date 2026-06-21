import { afterEach, describe, expect, it, vi } from "vitest";

const VIDEO_ENV_KEYS = [
  "PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS",
  "FILE_PREAUTH_RATE_LIMIT_MAX",
  "FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX",
  "FILE_PREAUTH_RATE_LIMIT_WINDOW_MS",
  "VIDEO_RANGE_RATE_LIMIT_MAX",
  "VIDEO_UNRESOLVED_RATE_LIMIT_MAX",
  "VIDEO_RANGE_RATE_LIMIT_WINDOW_MS",
  "DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX",
] as const;

const originalValues = new Map(VIDEO_ENV_KEYS.map((key) => [key, process.env[key]]));
const originalNodeEnv = process.env.NODE_ENV;
const originalSessionSecret = process.env.SESSION_SECRET;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else Object.assign(process.env, { [key]: value });
}

async function loadEnv(overrides: Partial<Record<(typeof VIDEO_ENV_KEYS)[number], string>> = {}) {
  for (const key of VIDEO_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides, {
    NODE_ENV: "test",
    SESSION_SECRET: "env-video-test-session-secret-0123456789",
  });
  vi.resetModules();
  const { getEnv } = await import("./env");
  return getEnv();
}

afterEach(() => {
  for (const key of VIDEO_ENV_KEYS) {
    const original = originalValues.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  restoreEnvValue("NODE_ENV", originalNodeEnv);
  restoreEnvValue("SESSION_SECRET", originalSessionSecret);
});

describe("inline video environment configuration", () => {
  it("uses safe production defaults", async () => {
    const env = await loadEnv();
    expect(env.PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS).toBe(21_600);
    expect(env.FILE_PREAUTH_RATE_LIMIT_MAX).toBe(1_200);
    expect(env.FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX).toBe(20_000);
    expect(env.FILE_PREAUTH_RATE_LIMIT_WINDOW_MS).toBe(600_000);
    expect(env.VIDEO_RANGE_RATE_LIMIT_MAX).toBe(600);
    expect(env.VIDEO_UNRESOLVED_RATE_LIMIT_MAX).toBe(10_000);
    expect(env.VIDEO_RANGE_RATE_LIMIT_WINDOW_MS).toBe(600_000);
    expect(env.DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX).toBe(2_000);
  });

  it("accepts valid finite integer overrides", async () => {
    const env = await loadEnv({
      PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS: "3600",
      FILE_PREAUTH_RATE_LIMIT_MAX: "5000",
      FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX: "40000",
      FILE_PREAUTH_RATE_LIMIT_WINDOW_MS: "120000",
      VIDEO_RANGE_RATE_LIMIT_MAX: "900",
      VIDEO_UNRESOLVED_RATE_LIMIT_MAX: "12000",
      VIDEO_RANGE_RATE_LIMIT_WINDOW_MS: "300000",
      DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX: "4000",
    });
    expect(env).toMatchObject({
      PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS: 3600,
      FILE_PREAUTH_RATE_LIMIT_MAX: 5000,
      FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX: 40000,
      FILE_PREAUTH_RATE_LIMIT_WINDOW_MS: 120000,
      VIDEO_RANGE_RATE_LIMIT_MAX: 900,
      VIDEO_UNRESOLVED_RATE_LIMIT_MAX: 12000,
      VIDEO_RANGE_RATE_LIMIT_WINDOW_MS: 300000,
      DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX: 4000,
    });
  });

  it.each([
    ["PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS", "299"],
    ["PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS", "86401"],
    ["FILE_PREAUTH_RATE_LIMIT_MAX", "99"],
    ["FILE_PREAUTH_RATE_LIMIT_MAX", "100001"],
    ["FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX", "1999"],
    ["FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX", "1000001"],
    ["FILE_PREAUTH_RATE_LIMIT_WINDOW_MS", "9999"],
    ["FILE_PREAUTH_RATE_LIMIT_WINDOW_MS", "86400001"],
    ["VIDEO_RANGE_RATE_LIMIT_MAX", "49"],
    ["VIDEO_RANGE_RATE_LIMIT_MAX", "10001"],
    ["VIDEO_UNRESOLVED_RATE_LIMIT_MAX", "999"],
    ["VIDEO_UNRESOLVED_RATE_LIMIT_MAX", "500001"],
    ["VIDEO_RANGE_RATE_LIMIT_WINDOW_MS", "9999"],
    ["VIDEO_RANGE_RATE_LIMIT_WINDOW_MS", "86400001"],
    ["DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX", "499"],
    ["DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX", "100001"],
    ["VIDEO_RANGE_RATE_LIMIT_MAX", "NaN"],
    ["DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX", "NaN"],
    ["FILE_PREAUTH_RATE_LIMIT_MAX", "-1"],
    ["VIDEO_UNRESOLVED_RATE_LIMIT_MAX", "-1"],
    ["PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS", "Infinity"],
    ["FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX", "Infinity"],
  ] as const)("rejects invalid %s=%s", async (key, value) => {
    await expect(loadEnv({ [key]: value })).rejects.toThrow("环境变量配置错误");
  });
});
