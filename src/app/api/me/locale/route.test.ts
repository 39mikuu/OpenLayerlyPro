import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, updateUserLocale } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateUserLocale: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireUser }));
vi.mock("@/modules/user", () => ({ updateUserLocale }));

import { PUT } from "./route";

function request(locale: string): NextRequest {
  return new Request("http://localhost/api/me/locale", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale }),
  }) as NextRequest;
}

describe("PUT /api/me/locale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1" });
    updateUserLocale.mockResolvedValue(undefined);
  });

  it("persists Japanese as the user locale", async () => {
    const response = await PUT(request("ja"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { locale: "ja" } });
    expect(updateUserLocale).toHaveBeenCalledWith("user-1", "ja");
  });
});
