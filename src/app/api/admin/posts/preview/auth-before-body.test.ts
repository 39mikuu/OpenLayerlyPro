import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  readJsonWithLimit: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readJsonWithLimit: mocks.readJsonWithLimit,
  };
});
vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));

import { POST } from "./route";

function oversizedPreviewRequest(): NextRequest {
  return new Request("http://localhost/api/admin/posts/preview", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "999999999",
    },
    body: "{",
  }) as NextRequest;
}

describe("admin post preview auth-before-body invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
    mocks.rateLimit.mockReturnValue(true);
    mocks.readJsonWithLimit.mockResolvedValue({ markdown: "# Preview", embedMode: "preview" });
  });

  it("returns 401 before post-auth rate limiting or body parsing", async () => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(oversizedPreviewRequest());

    expect(response.status).toBe(401);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
  });

  it("orders auth before the admin-id rate limit and rate limit before body parsing", async () => {
    const response = await POST(oversizedPreviewRequest());

    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledWith("admin-markdown-preview:admin-1", 60, 60_000);
    expect(mocks.requireAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rateLimit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readJsonWithLimit.mock.invocationCallOrder[0]!,
    );
  });
});
