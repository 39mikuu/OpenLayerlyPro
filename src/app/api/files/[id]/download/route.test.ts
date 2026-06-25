import { NextRequest } from "next/server";
import { Readable } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { __resetUnresolvedClientWarningForTests } from "@/modules/download/rate-limit-policy";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  getClientIp: vi.fn(),
  getUserAgent: vi.fn(),
  getEnv: vi.fn(),
  rateLimit: vi.fn(),
  getCurrentUser: vi.fn(),
  authorizeFileAccess: vi.fn(),
  prepareAuthorizedDownload: vi.fn(),
  getFileById: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getClientIp: mocks.getClientIp,
    getUserAgent: mocks.getUserAgent,
  };
});
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/modules/download", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/download")>();
  return {
    ...actual,
    authorizeFileAccess: mocks.authorizeFileAccess,
    prepareAuthorizedDownload: mocks.prepareAuthorizedDownload,
  };
});
vi.mock("@/modules/file", () => ({ getFileById: mocks.getFileById }));

import { GET } from "./route";

const VIDEO_FILE = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  purpose: "content_attachment",
  storageDriver: "local",
  bucket: null,
  objectKey: "content/video.mp4",
  originalName: "video.mp4",
  mimeType: "video/mp4",
  sizeBytes: 1000,
};

const ATTACHMENT_FILE = {
  ...VIDEO_FILE,
  id: "550e8400-e29b-41d4-a716-446655440001",
  objectKey: "content/archive.zip",
  originalName: "archive.zip",
  mimeType: "application/zip",
};

const IMAGE_FILE = {
  ...VIDEO_FILE,
  id: "550e8400-e29b-41d4-a716-446655440002",
  purpose: "content_image",
  objectKey: "content/image.png",
  originalName: "image.png",
  mimeType: "image/png",
};

const PAYMENT_PROOF_FILE = {
  ...IMAGE_FILE,
  id: "550e8400-e29b-41d4-a716-446655440003",
  purpose: "payment_proof",
  objectKey: "payment-proof/proof.jpg",
  originalName: "proof.jpg",
  mimeType: "image/jpeg",
};

const DEFAULT_ENV = {
  NODE_ENV: "test",
  FILE_PREAUTH_RATE_LIMIT_MAX: 100,
  FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX: 20_000,
  FILE_PREAUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  VIDEO_RANGE_RATE_LIMIT_MAX: 2,
  VIDEO_UNRESOLVED_RATE_LIMIT_MAX: 10_000,
  VIDEO_RANGE_RATE_LIMIT_WINDOW_MS: 60_000,
  DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX: 2_000,
};

function request(
  fileId = VIDEO_FILE.id,
  options: { range?: string; inline?: boolean } = {},
): NextRequest {
  const url = new URL(`http://localhost/api/files/${fileId}/download`);
  if (options.inline) url.searchParams.set("mode", "inline");
  return new NextRequest(url, {
    headers: options.range ? { Range: options.range } : undefined,
  });
}

async function call(fileId = VIDEO_FILE.id, options: { range?: string; inline?: boolean } = {}) {
  return GET(request(fileId, options), { params: Promise.resolve({ id: fileId }) });
}

describe("file download route security and Range behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUnresolvedClientWarningForTests();
    mocks.order.length = 0;
    mocks.getClientIp.mockReturnValue("198.51.100.10");
    mocks.getUserAgent.mockReturnValue("vitest");
    mocks.getEnv.mockReturnValue(DEFAULT_ENV);
    mocks.rateLimit.mockImplementation((key: string) => {
      mocks.order.push(`rate:${key}`);
      return true;
    });
    mocks.getFileById.mockImplementation(async () => {
      mocks.order.push("file");
      return VIDEO_FILE;
    });
    mocks.getCurrentUser.mockImplementation(async () => {
      mocks.order.push("user");
      return null;
    });
    mocks.authorizeFileAccess.mockImplementation(async () => {
      mocks.order.push("authorize");
      return { postId: "post-public", visibility: "public" };
    });
    mocks.prepareAuthorizedDownload.mockImplementation(async () => {
      mocks.order.push("prepare");
      return { mode: "stream", stream: Readable.from([Buffer.alloc(1000)]), file: VIDEO_FILE };
    });
  });

  it("executes the shared pre-auth IP bucket before file lookup", async () => {
    const response = await call(VIDEO_FILE.id, { inline: true });

    expect(response.status).toBe(200);
    expect(mocks.order[0]).toBe("rate:file-preauth:198.51.100.10");
    expect(mocks.order.indexOf("file")).toBeGreaterThan(0);
    expect(mocks.order).toEqual([
      "rate:file-preauth:198.51.100.10",
      "file",
      "user",
      "authorize",
      `rate:video:198.51.100.10:${VIDEO_FILE.id}`,
      "prepare",
    ]);
  });

  it("uses one pre-auth key for missing, unauthorized, authorized, Range, and inline requests", async () => {
    mocks.rateLimit.mockReturnValue(false);

    for (const [fileId, options] of [
      ["missing", {}],
      ["unauthorized", { range: "bytes=999999-" }],
      [VIDEO_FILE.id, { inline: true }],
    ] as const) {
      const response = await call(fileId, options);
      expect(response.status).toBe(429);
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      const payload = await response.json();
      expect(payload.code).toBe("downloadRateLimited");
    }

    expect(mocks.rateLimit).toHaveBeenCalledTimes(3);
    expect(mocks.rateLimit.mock.calls.map((entry) => entry[0])).toEqual([
      "file-preauth:198.51.100.10",
      "file-preauth:198.51.100.10",
      "file-preauth:198.51.100.10",
    ]);
    expect(mocks.getFileById).not.toHaveBeenCalled();
    expect(mocks.authorizeFileAccess).not.toHaveBeenCalled();
  });

  it("isolates the pre-auth bucket by IP without including fileId", async () => {
    mocks.rateLimit.mockReturnValue(false);
    mocks.getClientIp.mockReturnValueOnce("198.51.100.1").mockReturnValueOnce("198.51.100.2");

    await call("first");
    await call("second");

    expect(mocks.rateLimit.mock.calls.map((entry) => entry[0])).toEqual([
      "file-preauth:198.51.100.1",
      "file-preauth:198.51.100.2",
    ]);
  });

  it("uses dedicated emergency pre-auth and anonymous video buckets when IP is unavailable", async () => {
    mocks.getClientIp.mockReturnValue(null);

    const response = await call(VIDEO_FILE.id, { inline: true });

    expect(response.status).toBe(200);
    expect(mocks.rateLimit.mock.calls).toEqual([
      ["file-preauth-unresolved", 20_000, 60_000],
      [`video-unresolved:${VIDEO_FILE.id}`, 10_000, 60_000],
    ]);
    expect(JSON.stringify(mocks.rateLimit.mock.calls)).not.toContain("unknown");
  });

  it("emits a rate-limited production warning while unresolved fallback is active", async () => {
    mocks.getClientIp.mockReturnValue(null);
    mocks.getEnv.mockReturnValue({ ...DEFAULT_ENV, NODE_ENV: "production" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await call(VIDEO_FILE.id, { inline: true });
    await call(VIDEO_FILE.id, { inline: true });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("TRUSTED_PROXY_HEADER/TRUSTED_PROXY_HOPS");
    warn.mockRestore();
  });

  it("uses the dedicated unresolved download bucket instead of the ordinary anonymous limit", async () => {
    mocks.getClientIp.mockReturnValue(null);
    mocks.getFileById.mockResolvedValue(ATTACHMENT_FILE);
    mocks.prepareAuthorizedDownload.mockResolvedValue({
      mode: "stream",
      stream: Readable.from([Buffer.alloc(1000)]),
      file: ATTACHMENT_FILE,
    });

    const response = await call(ATTACHMENT_FILE.id);

    expect(response.status).toBe(200);
    expect(mocks.rateLimit.mock.calls).toEqual([
      ["file-preauth-unresolved", 20_000, 60_000],
      ["download-unresolved", 2_000, 600_000],
    ]);
    expect(JSON.stringify(mocks.rateLimit.mock.calls)).not.toContain("unknown");
  });

  it("keeps authenticated users isolated post-auth when pre-auth IP is unresolved", async () => {
    mocks.getClientIp.mockReturnValue(null);
    mocks.getCurrentUser
      .mockResolvedValueOnce({ id: "member-a", role: "member" })
      .mockResolvedValueOnce({ id: "member-b", role: "member" });

    expect((await call(VIDEO_FILE.id, { inline: true })).status).toBe(200);
    expect((await call(VIDEO_FILE.id, { inline: true })).status).toBe(200);

    expect(mocks.rateLimit.mock.calls.map((entry) => entry[0])).toEqual([
      "file-preauth-unresolved",
      `video:member-a:${VIDEO_FILE.id}`,
      "file-preauth-unresolved",
      `video:member-b:${VIDEO_FILE.id}`,
    ]);
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, "file-preauth-unresolved", 20_000, 60_000);
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(3, "file-preauth-unresolved", 20_000, 60_000);
  });

  it("returns a uniform 429 when the unresolved pre-auth emergency bucket is exhausted", async () => {
    mocks.getClientIp.mockReturnValue(null);
    mocks.rateLimit.mockReturnValue(false);

    const response = await call("missing", { range: "bytes=999999-", inline: true });
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload.code).toBe("downloadRateLimited");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(mocks.rateLimit).toHaveBeenCalledWith("file-preauth-unresolved", 20_000, 60_000);
    expect(mocks.getFileById).not.toHaveBeenCalled();
    expect(mocks.authorizeFileAccess).not.toHaveBeenCalled();
    expect(mocks.prepareAuthorizedDownload).not.toHaveBeenCalled();
  });

  it("returns a uniform 429 when the unresolved anonymous video bucket is exhausted", async () => {
    mocks.getClientIp.mockReturnValue(null);
    mocks.rateLimit.mockImplementation((key: string) => key === "file-preauth-unresolved");

    const response = await call(VIDEO_FILE.id, { range: "bytes=999999-", inline: true });
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload.code).toBe("downloadRateLimited");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(mocks.rateLimit.mock.calls).toEqual([
      ["file-preauth-unresolved", 20_000, 60_000],
      [`video-unresolved:${VIDEO_FILE.id}`, 10_000, 60_000],
    ]);
    expect(mocks.prepareAuthorizedDownload).not.toHaveBeenCalled();
  });

  it.each([
    [null, 401, "authRequired"],
    [{ id: "user-1", role: "member" }, 403, "memberAccessDenied"],
  ])("authorizes before parsing an unsatisfiable Range (%s)", async (user, status, code) => {
    mocks.getCurrentUser.mockResolvedValue(user);
    mocks.authorizeFileAccess.mockRejectedValue(new ApiError(status, code));

    const response = await call(VIDEO_FILE.id, { range: "bytes=999999999-", inline: true });
    const payload = await response.json();

    expect(response.status).toBe(status);
    expect(payload.code).toBe(code);
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(mocks.prepareAuthorizedDownload).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
  });

  it("returns 416 only after authorization and post-auth limiting", async () => {
    const response = await call(VIDEO_FILE.id, { range: "bytes=1000-", inline: true });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe("");
    expect(mocks.prepareAuthorizedDownload).not.toHaveBeenCalled();
    expect(mocks.order.slice(-2)).toEqual([
      "authorize",
      `rate:video:198.51.100.10:${VIDEO_FILE.id}`,
    ]);
  });

  it("returns complete 200 headers for inline video playback", async () => {
    const response = await call(VIDEO_FILE.id, { inline: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''video.mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(mocks.prepareAuthorizedDownload).toHaveBeenCalledWith(
      expect.objectContaining({ inline: true, range: undefined, log: true }),
    );
  });

  it("returns exact 206 headers and logs only initial ranges", async () => {
    const initial = await call(VIDEO_FILE.id, { range: "bytes=0-99", inline: true });
    expect(initial.status).toBe(206);
    expect(initial.headers.get("content-length")).toBe("100");
    expect(initial.headers.get("content-range")).toBe("bytes 0-99/1000");
    expect(initial.headers.get("content-disposition")).toContain("inline;");
    expect(mocks.prepareAuthorizedDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: { start: 0, end: 99 }, log: true }),
    );

    const seek = await call(VIDEO_FILE.id, { range: "bytes=500-", inline: true });
    expect(seek.status).toBe(206);
    expect(seek.headers.get("content-length")).toBe("500");
    expect(seek.headers.get("content-range")).toBe("bytes 500-999/1000");
    expect(mocks.prepareAuthorizedDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: { start: 500, end: 999 }, log: false }),
    );
  });

  it("ignores malformed Range and returns a complete 200", async () => {
    const response = await call(VIDEO_FILE.id, { range: "bytes=10-1", inline: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("content-range")).toBeNull();
    expect(mocks.prepareAuthorizedDownload).toHaveBeenCalledWith(
      expect.objectContaining({ range: undefined, log: true }),
    );
  });

  it("keeps non-video mode=inline as attachment and in the ordinary download bucket", async () => {
    mocks.getFileById.mockResolvedValue(ATTACHMENT_FILE);
    mocks.prepareAuthorizedDownload.mockResolvedValue({
      mode: "stream",
      stream: Readable.from([Buffer.alloc(1000)]),
      file: ATTACHMENT_FILE,
    });

    const response = await call(ATTACHMENT_FILE.id, { inline: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''archive.zip",
    );
    expect(mocks.rateLimit.mock.calls.map((entry) => entry[0])).toEqual([
      "file-preauth:198.51.100.10",
      "download-ip:198.51.100.10",
    ]);
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, "download-ip:198.51.100.10", 120, 600_000);
    expect(mocks.prepareAuthorizedDownload).toHaveBeenCalledWith(
      expect.objectContaining({ inline: false }),
    );
  });

  it("preserves default image inline delivery but ignores explicit mode=inline for non-video", async () => {
    mocks.getFileById.mockResolvedValue(IMAGE_FILE);
    mocks.prepareAuthorizedDownload.mockResolvedValue({
      mode: "stream",
      stream: Readable.from([Buffer.alloc(1000)]),
      file: IMAGE_FILE,
    });

    const defaultResponse = await call(IMAGE_FILE.id);
    expect(defaultResponse.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''image.png",
    );

    const explicitResponse = await call(IMAGE_FILE.id, { inline: true });
    expect(explicitResponse.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''image.png",
    );
  });

  it("always serves payment proof as attachment", async () => {
    mocks.getFileById.mockResolvedValue(PAYMENT_PROOF_FILE);
    mocks.prepareAuthorizedDownload.mockResolvedValue({
      mode: "stream",
      stream: Readable.from([Buffer.alloc(1000)]),
      file: PAYMENT_PROOF_FILE,
    });

    const response = await call(PAYMENT_PROOF_FILE.id);

    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''proof.jpg",
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("applies a configurable per-principal, per-file video bucket", async () => {
    const counts = new Map<string, number>();
    mocks.rateLimit.mockImplementation((key: string, limit: number) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return key.startsWith("file-preauth:") || next <= limit;
    });
    mocks.getCurrentUser.mockResolvedValue({ id: "member-a", role: "member" });

    expect((await call(VIDEO_FILE.id, { range: "bytes=0-9" })).status).toBe(206);
    expect((await call(VIDEO_FILE.id, { range: "bytes=10-19" })).status).toBe(206);
    expect((await call(VIDEO_FILE.id, { range: "bytes=20-29" })).status).toBe(429);
    expect(mocks.prepareAuthorizedDownload).toHaveBeenCalledTimes(2);

    const otherFile = { ...VIDEO_FILE, id: "550e8400-e29b-41d4-a716-446655440099" };
    mocks.getFileById.mockResolvedValue(otherFile);
    expect((await call(otherFile.id, { range: "bytes=20-29" })).status).toBe(206);

    mocks.getCurrentUser.mockResolvedValue({ id: "member-b", role: "member" });
    mocks.getFileById.mockResolvedValue(VIDEO_FILE);
    expect((await call(VIDEO_FILE.id, { range: "bytes=20-29" })).status).toBe(206);
  });

  it("sets no-store and nosniff on public S3 inline redirects", async () => {
    mocks.prepareAuthorizedDownload.mockResolvedValue({
      mode: "redirect",
      url: "https://storage.example/signed-video",
    });

    const response = await call(VIDEO_FILE.id, { inline: true });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://storage.example/signed-video");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
