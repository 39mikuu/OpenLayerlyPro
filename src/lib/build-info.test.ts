import { afterEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../package.json";

const BUILD_ENV_KEYS = ["APP_VERSION", "SOURCE_COMMIT", "BUILD_TIMESTAMP"] as const;
const MODULE_PATH = "./build-info";
const originalValues = new Map<(typeof BUILD_ENV_KEYS)[number], string | undefined>(
  BUILD_ENV_KEYS.map((key) => [key, process.env[key]]),
);
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

function restoreBuildEnv(): void {
  for (const key of BUILD_ENV_KEYS) {
    const value = originalValues.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
}

async function getBuildInfoFresh() {
  vi.resetModules();
  const buildInfoModule = await import(MODULE_PATH);
  return buildInfoModule.getBuildInfo();
}

describe("getBuildInfo", () => {
  afterEach(() => {
    restoreBuildEnv();
  });

  it("uses immutable in-image build metadata when present", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        appVersion: "2.0.0",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        buildTimestamp: "2026-07-05T00:00:00Z",
      }),
    );
    process.env.APP_VERSION = "env-version";
    process.env.SOURCE_COMMIT = "env-commit";
    process.env.BUILD_TIMESTAMP = "env-timestamp";

    await expect(getBuildInfoFresh()).resolves.toEqual({
      appVersion: "2.0.0",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      buildTimestamp: "2026-07-05T00:00:00Z",
    });
  });

  it("never falls back to build environment when metadata file is malformed", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{not-json");
    process.env.APP_VERSION = "1.2.3";
    process.env.SOURCE_COMMIT = "abc123";
    process.env.BUILD_TIMESTAMP = "2026-07-05T00:00:00Z";

    await expect(getBuildInfoFresh()).resolves.toEqual({
      appVersion: packageJson.version,
      sourceCommit: "dev",
      buildTimestamp: "unknown",
    });
  });

  it("falls back to build environment when metadata file is absent", async () => {
    mockExistsSync.mockReturnValue(false);
    process.env.APP_VERSION = "1.2.3";
    process.env.SOURCE_COMMIT = "abc123";
    process.env.BUILD_TIMESTAMP = "2026-07-05T00:00:00Z";

    await expect(getBuildInfoFresh()).resolves.toEqual({
      appVersion: "1.2.3",
      sourceCommit: "abc123",
      buildTimestamp: "2026-07-05T00:00:00Z",
    });
  });

  it("falls back to clearly marked dev metadata outside an image", async () => {
    mockExistsSync.mockReturnValue(false);
    delete process.env.APP_VERSION;
    delete process.env.SOURCE_COMMIT;
    delete process.env.BUILD_TIMESTAMP;

    await expect(getBuildInfoFresh()).resolves.toEqual({
      appVersion: packageJson.version,
      sourceCommit: "dev",
      buildTimestamp: "unknown",
    });
  });

  it("treats blank build environment as absent", async () => {
    mockExistsSync.mockReturnValue(false);
    process.env.APP_VERSION = "  ";
    process.env.SOURCE_COMMIT = "";
    process.env.BUILD_TIMESTAMP = " \t ";

    await expect(getBuildInfoFresh()).resolves.toEqual({
      appVersion: packageJson.version,
      sourceCommit: "dev",
      buildTimestamp: "unknown",
    });
  });
});
