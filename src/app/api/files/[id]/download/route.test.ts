import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  authorizeAndPrepareDownload: vi.fn(),
  getFileById: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/modules/download", () => ({
  authorizeAndPrepareDownload: mocks.authorizeAndPrepareDownload,
}));
vi.mock("@/modules/file", () => ({ getFileById: mocks.getFileById }));

import { GET } from "./route";

const FILE = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  purpose: "content_image",
  storageDriver: "local",
  bucket: null,
  objectKey: "content/draft-inline.png",
  originalName: "draft-inline.png",
  mimeType: "image/png",
  sizeBytes: 10,
};

function request() {
  return new NextRequest(`http://localhost/api/files/${FILE.id}/download`);
}

describe("file download API authorization boundary", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "download-route-test-session-secret-0123456789";
    vi.clearAllMocks();
    __resetRateLimitForTests();
    mocks.getFileById.mockResolvedValue(FILE);
  });

  it("returns 401 when an anonymous visitor cannot access a draft-only inline image", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.authorizeAndPrepareDownload.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await GET(request(), { params: Promise.resolve({ id: FILE.id }) });
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.code).toBe("authRequired");
    expect(payload.code).not.toContain("draft");
  });

  it("returns 403 without exposing draft state to an authenticated visitor", async () => {
    const user = { id: "user-id", role: "member" };
    mocks.getCurrentUser.mockResolvedValue(user);
    mocks.authorizeAndPrepareDownload.mockRejectedValue(new ApiError(403, "memberAccessDenied"));

    const response = await GET(request(), { params: Promise.resolve({ id: FILE.id }) });
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.code).toBe("memberAccessDenied");
    expect(payload.code).not.toContain("draft");
  });
});
