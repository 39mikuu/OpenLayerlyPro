import { afterEach, describe, expect, it } from "vitest";

import { getBuildInfo } from "./build-info";

const BUILD_ENV_KEYS = ["APP_VERSION", "SOURCE_COMMIT", "BUILD_TIMESTAMP"] as const;
const originalValues = new Map<(typeof BUILD_ENV_KEYS)[number], string | undefined>(
  BUILD_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restoreBuildEnv(): void {
  for (const key of BUILD_ENV_KEYS) {
    const value = originalValues.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("getBuildInfo", () => {
  afterEach(() => {
    restoreBuildEnv();
  });

  it("uses image-provided build environment when present", () => {
    process.env.APP_VERSION = "1.2.3";
    process.env.SOURCE_COMMIT = "abc123";
    process.env.BUILD_TIMESTAMP = "2026-07-05T00:00:00Z";

    expect(getBuildInfo()).toEqual({
      appVersion: "1.2.3",
      sourceCommit: "abc123",
      buildTimestamp: "2026-07-05T00:00:00Z",
    });
  });

  it("falls back to clearly marked dev metadata outside an image", () => {
    delete process.env.APP_VERSION;
    delete process.env.SOURCE_COMMIT;
    delete process.env.BUILD_TIMESTAMP;

    expect(getBuildInfo()).toEqual({
      appVersion: "0.2.0",
      sourceCommit: "dev",
      buildTimestamp: "dev",
    });
  });

  it("treats blank build environment as absent", () => {
    process.env.APP_VERSION = "  ";
    process.env.SOURCE_COMMIT = "";
    process.env.BUILD_TIMESTAMP = " \t ";

    expect(getBuildInfo()).toEqual({
      appVersion: "0.2.0",
      sourceCommit: "dev",
      buildTimestamp: "dev",
    });
  });
});
