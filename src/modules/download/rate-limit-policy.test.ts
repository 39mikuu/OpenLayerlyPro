import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@/lib/env";

import {
  __resetUnresolvedClientWarningForTests,
  getDownloadRateLimit,
  getFilePreAuthRateLimit,
  getVideoRateLimit,
  resolveClientRateLimitIdentity,
  warnUnresolvedClientRateLimitIdentity,
} from "./rate-limit-policy";

const env = {
  FILE_PREAUTH_RATE_LIMIT_MAX: 1_200,
  FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX: 20_000,
  FILE_PREAUTH_RATE_LIMIT_WINDOW_MS: 600_000,
  VIDEO_RANGE_RATE_LIMIT_MAX: 600,
  VIDEO_UNRESOLVED_RATE_LIMIT_MAX: 10_000,
  VIDEO_RANGE_RATE_LIMIT_WINDOW_MS: 600_000,
  DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX: 2_000,
} as Env;

describe("file request rate-limit policy", () => {
  beforeEach(() => {
    __resetUnresolvedClientWarningForTests();
  });

  it("uses normal per-IP buckets only for a resolved IP", () => {
    const identity = resolveClientRateLimitIdentity("198.51.100.10");
    expect(getFilePreAuthRateLimit(identity, env)).toEqual({
      key: "file-preauth:198.51.100.10",
      max: 1_200,
      windowMs: 600_000,
    });
    expect(getVideoRateLimit({ identity, userId: null, fileId: "file-a", env })).toEqual({
      key: "video:198.51.100.10:file-a",
      max: 600,
      windowMs: 600_000,
    });
    expect(getDownloadRateLimit({ identity, userId: null, env })).toEqual({
      key: "download-ip:198.51.100.10",
      max: 120,
      windowMs: 600_000,
    });
  });

  it("uses dedicated high-threshold emergency buckets when IP is unresolved", () => {
    const identity = resolveClientRateLimitIdentity(null);
    const preAuth = getFilePreAuthRateLimit(identity, env);
    const video = getVideoRateLimit({ identity, userId: null, fileId: "file-a", env });
    const download = getDownloadRateLimit({ identity, userId: null, env });

    expect(preAuth).toEqual({
      key: "file-preauth-unresolved",
      max: 20_000,
      windowMs: 600_000,
    });
    expect(video).toEqual({
      key: "video-unresolved:file-a",
      max: 10_000,
      windowMs: 600_000,
    });
    expect(download).toEqual({
      key: "download-unresolved",
      max: 2_000,
      windowMs: 600_000,
    });
    expect(`${preAuth.key} ${video.key} ${download.key}`).not.toContain("unknown");
  });

  it("uses authenticated users for post-auth buckets even without an IP", () => {
    const identity = resolveClientRateLimitIdentity(null);
    expect(getVideoRateLimit({ identity, userId: "user-a", fileId: "file-a", env })).toEqual({
      key: "video:user-a:file-a",
      max: 600,
      windowMs: 600_000,
    });
    expect(getDownloadRateLimit({ identity, userId: "user-b", env })).toEqual({
      key: "download:user-b",
      max: 120,
      windowMs: 600_000,
    });
  });

  it("keeps different resolved IPs in different buckets", () => {
    const first = resolveClientRateLimitIdentity("198.51.100.1");
    const second = resolveClientRateLimitIdentity("198.51.100.2");
    expect(getFilePreAuthRateLimit(first, env).key).not.toBe(
      getFilePreAuthRateLimit(second, env).key,
    );
  });

  it("rate-limits the unresolved-client operational warning", () => {
    const warn = vi.fn();
    expect(warnUnresolvedClientRateLimitIdentity({ now: 1_000, warn })).toBe(true);
    expect(warnUnresolvedClientRateLimitIdentity({ now: 2_000, warn })).toBe(false);
    expect(warnUnresolvedClientRateLimitIdentity({ now: 301_000, warn })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
