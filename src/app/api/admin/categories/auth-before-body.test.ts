import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  readJsonWithLimit: vi.fn(),
  requireAdmin: vi.fn(),
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readJsonWithLimit: mocks.readJsonWithLimit,
  };
});
vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/taxonomy", () => ({
  listCategories: mocks.listCategories,
  createCategory: mocks.createCategory,
  updateCategory: mocks.updateCategory,
  deleteCategory: mocks.deleteCategory,
}));

import { DELETE, PUT } from "./[id]/route";
import { POST } from "./route";

function oversizedJsonRequest(url: string, method: string): NextRequest {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "content-length": "999999999",
    },
    body: "{",
  }) as NextRequest;
}

function context(id = "category-1") {
  return { params: Promise.resolve({ id }) };
}

describe("admin category auth-before-body invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.readJsonWithLimit.mockResolvedValue({ name: "News" });
    mocks.listCategories.mockResolvedValue([]);
    mocks.createCategory.mockResolvedValue({ id: "category-1" });
    mocks.updateCategory.mockResolvedValue({ id: "category-1" });
    mocks.deleteCategory.mockResolvedValue(undefined);
  });

  it.each([
    ["POST", () => POST(oversizedJsonRequest("http://localhost/api/admin/categories", "POST"))],
    [
      "PUT with path params",
      () =>
        PUT(
          oversizedJsonRequest("http://localhost/api/admin/categories/category-1", "PUT"),
          context(),
        ),
    ],
  ])("returns 401 before reading an unauthenticated oversized %s body", async (_name, call) => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await call();

    expect(response.status).toBe(401);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.createCategory).not.toHaveBeenCalled();
    expect(mocks.updateCategory).not.toHaveBeenCalled();
  });

  it("returns role-mismatch 403 before reading an admin-only JSON body", async () => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(403, "adminRequired"));

    const response = await POST(
      oversizedJsonRequest("http://localhost/api/admin/categories", "POST"),
    );

    expect(response.status).toBe(403);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.createCategory).not.toHaveBeenCalled();
  });

  it("gates a protected bodyless route before path-param side effects", async () => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await DELETE(
      new Request("http://localhost/api/admin/categories/category-1", {
        method: "DELETE",
      }) as NextRequest,
      context(),
    );

    expect(response.status).toBe(401);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.deleteCategory).not.toHaveBeenCalled();
  });
});
