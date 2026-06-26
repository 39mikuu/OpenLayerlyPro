import { afterEach, describe, expect, it, vi } from "vitest";

const AUTH_ENV_KEYS = [
  "LOGIN_CODE_LENGTH",
  "LOGIN_CODE_ALPHABET",
  "ADMIN_LOGIN_RATE_MAX",
  "ADMIN_LOGIN_UNRESOLVED_RATE_MAX",
  "ADMIN_LOGIN_RATE_WINDOW_MS",
  "VERIFY_CODE_IP_RATE_MAX",
  "VERIFY_CODE_EMAIL_IP_RATE_MAX",
  "VERIFY_CODE_UNRESOLVED_RATE_MAX",
  "VERIFY_CODE_RATE_WINDOW_MS",
  "REQUEST_CODE_IP_RATE_MAX",
  "REQUEST_CODE_EMAIL_IP_RATE_MAX",
  "REQUEST_CODE_UNRESOLVED_RATE_MAX",
  "REQUEST_CODE_RATE_WINDOW_MS",
  "REQUEST_CODE_SEND_DEDUPE_SECONDS",
] as const;

const originalValues = new Map(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));
const originalNodeEnv = process.env.NODE_ENV;
const originalSessionSecret = process.env.SESSION_SECRET;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

async function loadEnv(overrides: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>> = {}) {
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides, {
    NODE_ENV: "test",
    SESSION_SECRET: "auth-rate-limit-env-test-session-secret-0123456789",
  });
  vi.resetModules();
  const { getEnv } = await import("./env");
  return getEnv();
}

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) restoreEnvValue(key, originalValues.get(key));
  restoreEnvValue("NODE_ENV", originalNodeEnv);
  restoreEnvValue("SESSION_SECRET", originalSessionSecret);
});

describe("auth rate-limit environment configuration", () => {
  it("uses S4 defaults", async () => {
    await expect(loadEnv()).resolves.toMatchObject({
      LOGIN_CODE_LENGTH: 16,
      LOGIN_CODE_ALPHABET: "crockford-base32",
      ADMIN_LOGIN_RATE_MAX: 10,
      VERIFY_CODE_IP_RATE_MAX: 30,
      VERIFY_CODE_EMAIL_IP_RATE_MAX: 10,
      REQUEST_CODE_IP_RATE_MAX: 20,
      REQUEST_CODE_EMAIL_IP_RATE_MAX: 5,
      REQUEST_CODE_SEND_DEDUPE_SECONDS: 60,
    });
  });

  it("rejects login-code entropy below the 80-bit S4 floor", async () => {
    await expect(loadEnv({ LOGIN_CODE_LENGTH: "15" })).rejects.toThrow("环境变量配置错误");
  });

  it("rejects unsupported login-code alphabets", async () => {
    await expect(loadEnv({ LOGIN_CODE_ALPHABET: "decimal" })).rejects.toThrow("环境变量配置错误");
  });
});
