import type { Env } from "@/lib/env";
export type { ClientRateLimitIdentity } from "@/lib/client-rate-limit";
export {
  __resetUnresolvedClientWarningForTests,
  resolveClientRateLimitIdentity,
  warnUnresolvedClientRateLimitIdentity,
} from "@/lib/client-rate-limit";

import type { ClientRateLimitIdentity } from "@/lib/client-rate-limit";

export type RateLimitPolicy = {
  key: string;
  max: number;
  windowMs: number;
};

const DOWNLOAD_RATE_LIMIT_MAX = 120;
const DOWNLOAD_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export function getFilePreAuthRateLimit(
  identity: ClientRateLimitIdentity,
  env: Env,
): RateLimitPolicy {
  if (identity.kind === "ip") {
    return {
      key: `file-preauth:${identity.value}`,
      max: env.FILE_PREAUTH_RATE_LIMIT_MAX,
      windowMs: env.FILE_PREAUTH_RATE_LIMIT_WINDOW_MS,
    };
  }
  return {
    key: "file-preauth-unresolved",
    max: env.FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX,
    windowMs: env.FILE_PREAUTH_RATE_LIMIT_WINDOW_MS,
  };
}

export function getVideoRateLimit(input: {
  identity: ClientRateLimitIdentity;
  userId: string | null;
  fileId: string;
  env: Env;
}): RateLimitPolicy {
  if (input.userId) {
    return {
      key: `video:${input.userId}:${input.fileId}`,
      max: input.env.VIDEO_RANGE_RATE_LIMIT_MAX,
      windowMs: input.env.VIDEO_RANGE_RATE_LIMIT_WINDOW_MS,
    };
  }
  if (input.identity.kind === "ip") {
    return {
      key: `video:${input.identity.value}:${input.fileId}`,
      max: input.env.VIDEO_RANGE_RATE_LIMIT_MAX,
      windowMs: input.env.VIDEO_RANGE_RATE_LIMIT_WINDOW_MS,
    };
  }
  return {
    key: `video-unresolved:${input.fileId}`,
    max: input.env.VIDEO_UNRESOLVED_RATE_LIMIT_MAX,
    windowMs: input.env.VIDEO_RANGE_RATE_LIMIT_WINDOW_MS,
  };
}

export function getDownloadRateLimit(input: {
  identity: ClientRateLimitIdentity;
  userId: string | null;
  env: Env;
}): RateLimitPolicy {
  if (input.userId) {
    return {
      key: `download:${input.userId}`,
      max: DOWNLOAD_RATE_LIMIT_MAX,
      windowMs: DOWNLOAD_RATE_LIMIT_WINDOW_MS,
    };
  }
  if (input.identity.kind === "ip") {
    return {
      key: `download-ip:${input.identity.value}`,
      max: DOWNLOAD_RATE_LIMIT_MAX,
      windowMs: DOWNLOAD_RATE_LIMIT_WINDOW_MS,
    };
  }
  return {
    key: "download-unresolved",
    max: input.env.DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX,
    windowMs: DOWNLOAD_RATE_LIMIT_WINDOW_MS,
  };
}
