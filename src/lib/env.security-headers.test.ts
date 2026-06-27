import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = [
  "APP_URL",
  "NODE_ENV",
  "SESSION_SECRET",
  "SECURITY_CSP_MODE",
  "SECURITY_HSTS_ENABLED",
] as const;
const originals = new Map(KEYS.map((key) => [key, process.env[key]]));

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function load(overrides: Partial<Record<(typeof KEYS)[number], string>> = {}) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "security-header-env-test-session-secret",
    ...overrides,
  });
  vi.resetModules();
  return (await import("./env")).getEnv();
}

afterEach(() => {
  for (const key of KEYS) restore(key, originals.get(key));
});

describe("security response header environment", () => {
  it("defaults to auto CSP and disabled HSTS", async () => {
    await expect(load()).resolves.toMatchObject({
      SECURITY_CSP_MODE: "auto",
      SECURITY_HSTS_ENABLED: false,
    });
  });

  it.each(["auto", "report-only", "enforce"] as const)("accepts CSP mode %s", async (mode) => {
    await expect(load({ SECURITY_CSP_MODE: mode })).resolves.toMatchObject({
      SECURITY_CSP_MODE: mode,
    });
  });

  it("requires an HTTPS public URL when HSTS is explicitly enabled", async () => {
    await expect(
      load({
        APP_URL: "http://artist.example",
        SECURITY_HSTS_ENABLED: "true",
      }),
    ).rejects.toThrow("requires an HTTPS APP_URL");
    await expect(
      load({
        APP_URL: "https://artist.example",
        SECURITY_HSTS_ENABLED: "true",
      }),
    ).resolves.toMatchObject({ SECURITY_HSTS_ENABLED: true });
  });
});
