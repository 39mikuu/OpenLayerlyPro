import { existsSync, readFileSync } from "fs";

import packageJson from "../../package.json";

export type BuildInfo = {
  appVersion: string;
  sourceCommit: string;
  buildTimestamp: string;
};

const BUILD_INFO_PATH = "/app/build-info.json";

type ImageBuildInfoResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "ok"; info: BuildInfo };

let cachedImageBuildInfo: ImageBuildInfoResult | undefined;

function envOrFallback(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readImageBuildInfo(): ImageBuildInfoResult {
  if (cachedImageBuildInfo !== undefined) {
    return cachedImageBuildInfo;
  }

  if (!existsSync(BUILD_INFO_PATH)) {
    cachedImageBuildInfo = { kind: "absent" };
    return cachedImageBuildInfo;
  }

  cachedImageBuildInfo = { kind: "invalid" };
  try {
    const parsed = JSON.parse(readFileSync(BUILD_INFO_PATH, "utf8")) as {
      appVersion?: unknown;
      sourceCommit?: unknown;
      buildTimestamp?: unknown;
    };
    const appVersion = nonBlankString(parsed.appVersion);
    const sourceCommit = nonBlankString(parsed.sourceCommit);
    const buildTimestamp = nonBlankString(parsed.buildTimestamp);
    if (appVersion && sourceCommit && buildTimestamp) {
      cachedImageBuildInfo = { kind: "ok", info: { appVersion, sourceCommit, buildTimestamp } };
    }
  } catch {
    cachedImageBuildInfo = { kind: "invalid" };
  }

  return cachedImageBuildInfo;
}

export function getBuildInfo(): BuildInfo {
  const imageBuildInfo = readImageBuildInfo();
  if (imageBuildInfo.kind === "ok") {
    return imageBuildInfo.info;
  }

  if (imageBuildInfo.kind === "invalid") {
    // Baked image metadata exists but is unreadable. Never let runtime environment
    // variables substitute for it: env can be overridden per container (compose
    // env_file) and would silently misreport the image's build identity.
    return {
      appVersion: packageJson.version,
      sourceCommit: "dev",
      buildTimestamp: "unknown",
    };
  }

  return {
    appVersion: envOrFallback("APP_VERSION", packageJson.version),
    sourceCommit: envOrFallback("SOURCE_COMMIT", "dev"),
    buildTimestamp: envOrFallback("BUILD_TIMESTAMP", "unknown"),
  };
}
