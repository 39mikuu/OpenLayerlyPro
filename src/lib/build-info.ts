import packageJson from "../../package.json";

export type BuildInfo = {
  appVersion: string;
  sourceCommit: string;
  buildTimestamp: string;
};

function envOrFallback(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function getBuildInfo(): BuildInfo {
  return {
    appVersion: envOrFallback("APP_VERSION", packageJson.version),
    sourceCommit: envOrFallback("SOURCE_COMMIT", "dev"),
    buildTimestamp: envOrFallback("BUILD_TIMESTAMP", "dev"),
  };
}
