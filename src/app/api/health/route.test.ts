import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("health response security", () => {
  it("returns the stable health shape with nosniff", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ ok: true, status: "healthy" });
  });
});
