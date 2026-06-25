import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_POST_BODY_LENGTH, POST_JSON_MAX_BYTES } from "@/modules/content/markdown";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createPost: vi.fn(),
  listPosts: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/content", () => ({
  createPost: mocks.createPost,
  listPosts: mocks.listPosts,
}));

import * as route from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postInput(body: string) {
  return {
    title: "Title",
    slug: "title",
    body,
    visibility: "public",
    categoryIds: [],
    tagIds: [],
  };
}

describe("admin posts API JSON transfer limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.createPost.mockResolvedValue({ id: "post-1" });
  });

  it("accepts a 90,000 character ASCII body before business validation", async () => {
    const body = "x".repeat(90_000);
    const response = await route.POST(request(postInput(body)));

    expect(response.status).toBe(200);
    expect(mocks.createPost).toHaveBeenCalledWith(expect.objectContaining({ body }), {
      categoryIds: [],
      tagIds: [],
    });
  });

  it("accepts a near-limit multi-byte CJK body before business validation", async () => {
    const body = "界".repeat(MAX_POST_BODY_LENGTH - 1);
    const response = await route.POST(request(postInput(body)));

    expect(response.status).toBe(200);
    expect(mocks.createPost).toHaveBeenCalledWith(expect.objectContaining({ body }), {
      categoryIds: [],
      tagIds: [],
    });
  });

  it("keeps the schema character limit at 100,000 characters", async () => {
    const response = await route.POST(request(postInput("x".repeat(MAX_POST_BODY_LENGTH + 1))));

    expect(response.status).toBe(400);
    expect(mocks.createPost).not.toHaveBeenCalled();
  });

  it("rejects JSON transfers above the post-specific byte limit", async () => {
    const response = await route.POST(request(postInput("x".repeat(POST_JSON_MAX_BYTES))));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "requestBodyTooLarge" });
    expect(mocks.createPost).not.toHaveBeenCalled();
  });
});
