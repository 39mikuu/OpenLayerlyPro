import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { MAX_POST_BODY_LENGTH } from "@/modules/content/markdown";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  savePublishedPostBody: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/content", () => ({
  savePublishedPostBody: mocks.savePublishedPostBody,
}));

import * as route from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/posts/post-1/content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ id: "post-1" }) };
}

describe("published post body API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.savePublishedPostBody.mockResolvedValue({ id: "post-1", body: "Updated" });
  });

  it.each([
    [401, "authRequired"],
    [403, "adminRequired"],
  ])("requires admin access (%s)", async (status, code) => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(status, code));

    const response = await route.PUT(request({ body: "Updated" }), context());

    expect(response.status).toBe(status);
    expect(mocks.savePublishedPostBody).not.toHaveBeenCalled();
  });

  it("updates only the published body through the narrow helper", async () => {
    const response = await route.PUT(request({ body: "Updated" }), context());

    expect(response.status).toBe(200);
    expect(mocks.savePublishedPostBody).toHaveBeenCalledWith("post-1", "Updated");
    expect("GET" in route).toBe(false);
  });

  it.each([
    "title",
    "slug",
    "summary",
    "originalLocale",
    "visibility",
    "requiredTierId",
    "coverFileId",
    "categoryIds",
    "tagIds",
  ])("rejects protected published metadata field %s", async (field) => {
    const response = await route.PUT(
      request({ body: "Updated", [field]: field.endsWith("Ids") ? [] : "changed" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.savePublishedPostBody).not.toHaveBeenCalled();
  });

  it("rejects an oversized body", async () => {
    const response = await route.PUT(
      request({ body: "x".repeat(MAX_POST_BODY_LENGTH + 1) }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.savePublishedPostBody).not.toHaveBeenCalled();
  });
});
