import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_POST_BODY_LENGTH, POST_JSON_MAX_BYTES } from "@/modules/content/markdown";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  deletePost: vi.fn(),
  getPostById: vi.fn(),
  listPostFiles: vi.fn(),
  updatePost: vi.fn(),
  getPostTaxonomy: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/content", () => ({
  deletePost: mocks.deletePost,
  getPostById: mocks.getPostById,
  listPostFiles: mocks.listPostFiles,
  updatePost: mocks.updatePost,
}));
vi.mock("@/modules/taxonomy", () => ({ getPostTaxonomy: mocks.getPostTaxonomy }));

import * as route from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/posts/post-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ id: "post-1" }) };
}

describe("admin post update API JSON transfer limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.updatePost.mockResolvedValue({ id: "post-1" });
  });

  it("accepts a 90,000 character ASCII body before business validation", async () => {
    const body = "x".repeat(90_000);
    const response = await route.PUT(request({ body }), context());

    expect(response.status).toBe(200);
    expect(mocks.updatePost).toHaveBeenCalledWith("post-1", { body }, {});
  });

  it("accepts a near-limit multi-byte CJK body before business validation", async () => {
    const body = "界".repeat(MAX_POST_BODY_LENGTH - 1);
    const response = await route.PUT(request({ body }), context());

    expect(response.status).toBe(200);
    expect(mocks.updatePost).toHaveBeenCalledWith("post-1", { body }, {});
  });

  it("keeps the schema character limit at 100,000 characters", async () => {
    const response = await route.PUT(
      request({ body: "x".repeat(MAX_POST_BODY_LENGTH + 1) }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });

  it("rejects JSON transfers above the post-specific byte limit", async () => {
    const response = await route.PUT(request({ body: "x".repeat(POST_JSON_MAX_BYTES) }), context());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "requestBodyTooLarge" });
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });
});
