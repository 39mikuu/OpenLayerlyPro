import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = ["IMAGE_MAX_FRAMES", "IMAGE_MAX_TOTAL_PIXELS"] as const;
const original = new Map(KEYS.map((key) => [key, process.env[key]]));
const originalNodeEnv = process.env.NODE_ENV;
const originalSessionSecret = process.env.SESSION_SECRET;

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function load(overrides: Partial<Record<(typeof KEYS)[number], string>> = {}) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, overrides, {
    NODE_ENV: "test",
    SESSION_SECRET: "image-safety-env-test-session-secret-0123456789",
  });
  vi.resetModules();
  return (await import("./env")).getEnv();
}

afterEach(() => {
  for (const key of KEYS) restore(key, original.get(key));
  restore("NODE_ENV", originalNodeEnv);
  restore("SESSION_SECRET", originalSessionSecret);
});

describe("image safety environment configuration", () => {
  it("uses bounded defaults", async () => {
    await expect(load()).resolves.toMatchObject({
      IMAGE_MAX_FRAMES: 300,
      IMAGE_MAX_TOTAL_PIXELS: 300_000_000,
    });
  });

  it("accepts values at the declared boundaries", async () => {
    await expect(
      load({ IMAGE_MAX_FRAMES: "2000", IMAGE_MAX_TOTAL_PIXELS: "2000000000" }),
    ).resolves.toMatchObject({
      IMAGE_MAX_FRAMES: 2_000,
      IMAGE_MAX_TOTAL_PIXELS: 2_000_000_000,
    });
  });

  it.each([
    ["IMAGE_MAX_FRAMES", "0"],
    ["IMAGE_MAX_FRAMES", "2001"],
    ["IMAGE_MAX_FRAMES", "1.5"],
    ["IMAGE_MAX_TOTAL_PIXELS", "999999"],
    ["IMAGE_MAX_TOTAL_PIXELS", "2000000001"],
    ["IMAGE_MAX_TOTAL_PIXELS", "Infinity"],
  ] as const)("rejects rather than clamps %s=%s", async (key, value) => {
    await expect(load({ [key]: value })).rejects.toThrow("环境变量配置错误");
  });
});
