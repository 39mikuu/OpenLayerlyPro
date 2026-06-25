import { afterEach, describe, expect, it, vi } from "vitest";

const BODY_ENV_KEYS = [
  "REQUEST_JSON_MAX_BYTES",
  "STRIPE_WEBHOOK_MAX_BYTES",
  "PAYMENT_PROOF_MAX_SIZE_MB",
  "PAYMENT_PROOF_RETENTION_DAYS",
  "PAYMENT_PROOF_MAX_PER_DAY",
  "PROOF_UPLOAD_RESERVATION_TTL_MINUTES",
] as const;

const originalValues = new Map(BODY_ENV_KEYS.map((key) => [key, process.env[key]]));
const originalNodeEnv = process.env.NODE_ENV;
const originalSessionSecret = process.env.SESSION_SECRET;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

async function loadEnv(overrides: Partial<Record<(typeof BODY_ENV_KEYS)[number], string>> = {}) {
  for (const key of BODY_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides, {
    NODE_ENV: "test",
    SESSION_SECRET: "request-body-env-test-session-secret-0123456789",
  });
  vi.resetModules();
  const { getEnv } = await import("./env");
  return getEnv();
}

afterEach(() => {
  for (const key of BODY_ENV_KEYS) restoreEnvValue(key, originalValues.get(key));
  restoreEnvValue("NODE_ENV", originalNodeEnv);
  restoreEnvValue("SESSION_SECRET", originalSessionSecret);
});

describe("request body environment configuration", () => {
  it("uses bounded defaults", async () => {
    const env = await loadEnv();
    expect(env.REQUEST_JSON_MAX_BYTES).toBe(65_536);
    expect(env.STRIPE_WEBHOOK_MAX_BYTES).toBe(262_144);
    expect(env.PAYMENT_PROOF_MAX_SIZE_MB).toBe(10);
    expect(env.PAYMENT_PROOF_RETENTION_DAYS).toBe(30);
    expect(env.PAYMENT_PROOF_MAX_PER_DAY).toBe(20);
    expect(env.PROOF_UPLOAD_RESERVATION_TTL_MINUTES).toBe(5);
  });

  it("accepts finite integer values at the configured boundaries", async () => {
    await expect(
      loadEnv({
        REQUEST_JSON_MAX_BYTES: "1024",
        STRIPE_WEBHOOK_MAX_BYTES: "1048576",
        PAYMENT_PROOF_MAX_SIZE_MB: "100",
        PAYMENT_PROOF_RETENTION_DAYS: "3650",
        PAYMENT_PROOF_MAX_PER_DAY: "1000",
        PROOF_UPLOAD_RESERVATION_TTL_MINUTES: "60",
      }),
    ).resolves.toMatchObject({
      REQUEST_JSON_MAX_BYTES: 1024,
      STRIPE_WEBHOOK_MAX_BYTES: 1_048_576,
      PAYMENT_PROOF_MAX_SIZE_MB: 100,
      PAYMENT_PROOF_RETENTION_DAYS: 3650,
      PAYMENT_PROOF_MAX_PER_DAY: 1000,
      PROOF_UPLOAD_RESERVATION_TTL_MINUTES: 60,
    });
  });

  it.each([
    ["REQUEST_JSON_MAX_BYTES", "0"],
    ["REQUEST_JSON_MAX_BYTES", "1023"],
    ["REQUEST_JSON_MAX_BYTES", "1048577"],
    ["STRIPE_WEBHOOK_MAX_BYTES", "0"],
    ["STRIPE_WEBHOOK_MAX_BYTES", "1023"],
    ["STRIPE_WEBHOOK_MAX_BYTES", "1048577"],
    ["PAYMENT_PROOF_MAX_SIZE_MB", "0"],
    ["PAYMENT_PROOF_MAX_SIZE_MB", "-1"],
    ["PAYMENT_PROOF_MAX_SIZE_MB", "101"],
    ["PAYMENT_PROOF_RETENTION_DAYS", "0"],
    ["PAYMENT_PROOF_RETENTION_DAYS", "3651"],
    ["PAYMENT_PROOF_MAX_PER_DAY", "0"],
    ["PAYMENT_PROOF_MAX_PER_DAY", "1001"],
    ["PROOF_UPLOAD_RESERVATION_TTL_MINUTES", "0"],
    ["PROOF_UPLOAD_RESERVATION_TTL_MINUTES", "61"],
    ["REQUEST_JSON_MAX_BYTES", "1.5"],
    ["STRIPE_WEBHOOK_MAX_BYTES", "NaN"],
    ["PAYMENT_PROOF_MAX_SIZE_MB", "Infinity"],
  ] as const)("rejects invalid %s=%s", async (key, value) => {
    await expect(loadEnv({ [key]: value })).rejects.toThrow("环境变量配置错误");
  });
});
