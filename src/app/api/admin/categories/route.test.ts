import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listCategories: vi.fn(),
  createCategory: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/taxonomy", () => ({
  listCategories: mocks.listCategories,
  createCategory: mocks.createCategory,
}));

import { GET, POST } from "./route";

describe("admin categories API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.listCategories.mockResolvedValue([]);
    mocks.createCategory.mockResolvedValue({ id: "category" });
  });

  it.each([
    [401, "authRequired"],
    [403, "adminRequired"],
  ])("requires admin access (%s)", async (status, code) => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(status, code));
    const request = new NextRequest("http://localhost/api/admin/categories", {
      method: "POST",
      body: JSON.stringify({ name: "News" }),
    });

    const [getResponse, postResponse] = await Promise.all([GET(), POST(request)]);

    expect(getResponse.status).toBe(status);
    expect(postResponse.status).toBe(status);
    expect(mocks.listCategories).not.toHaveBeenCalled();
    expect(mocks.createCategory).not.toHaveBeenCalled();
  });

  it("returns 401 before parsing a malformed but normally sized unauthenticated JSON body", async () => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(401, "authRequired"));
    const response = await POST(
      new NextRequest("http://localhost/api/admin/categories", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "1" },
        body: "{",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "authRequired" });
    expect(mocks.createCategory).not.toHaveBeenCalled();
  });

  it("creates a category after authentication", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/admin/categories", {
        method: "POST",
        body: JSON.stringify({ name: "News", slug: "news", sortOrder: 1 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createCategory).toHaveBeenCalledWith({
      name: "News",
      slug: "news",
      sortOrder: 1,
    });
  });
});
