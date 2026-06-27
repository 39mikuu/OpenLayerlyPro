import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReadiness: vi.fn(),
}));

vi.mock("@/modules/system/readiness", () => ({
  getReadiness: mocks.getReadiness,
}));

import { GET } from "./route";

describe("readiness response security", () => {
  it("returns nosniff without changing the readiness shape or status", async () => {
    mocks.getReadiness.mockResolvedValue({
      ready: false,
      checks: { database: false },
      warnings: ["database unavailable"],
    });

    const response = await GET(new Request("http://localhost/api/ready") as unknown as NextRequest);

    expect(response.status).toBe(503);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "not_ready",
      checks: { database: false },
    });
  });
});
