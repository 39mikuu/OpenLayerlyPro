import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.APP_URL = "https://site.example/base";
});

import { GET } from "./route";

function request(headers: HeadersInit = {}) {
  return new NextRequest("https://site.example/base/robots.txt", { headers });
}

describe("robots.txt route", () => {
  it("returns explicit crawler rules with public cache validators", async () => {
    const response = await GET(request({ cookie: "locale=ja" }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
    );
    expect(response.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(body).toContain("Allow: /");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Sitemap: https://site.example/base/sitemap.xml");
    expect(body).not.toContain("Disallow: /posts");
  });

  it("returns 304 for wildcard If-None-Match", async () => {
    const response = await GET(request({ "if-none-match": "*" }));

    expect(response.status).toBe(304);
    await expect(response.text()).resolves.toBe("");
  });
});
