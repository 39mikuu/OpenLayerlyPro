import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { MAX_POST_BODY_LENGTH, renderMarkdown } from "@/modules/content/markdown";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn() }));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));

import * as route from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/posts/preview", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("admin Markdown preview API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-id", role: "admin" });
  });

  it.each([
    [401, "authRequired"],
    [403, "adminRequired"],
  ])("requires admin access (%s)", async (status, code) => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(status, code));
    const response = await route.POST(request({ markdown: "# Preview", embedMode: "preview" }));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("supports POST only and returns the shared sanitized renderer output", async () => {
    expect("GET" in route).toBe(false);
    const markdown = "# Preview\n\n<script>alert(1)</script>";
    const response = await route.POST(request({ markdown, embedMode: "preview" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.data.html).toBe(renderMarkdown(markdown, { embedMode: "preview" }));
    expect(payload.data.html).not.toContain("<script>");
  });

  it("returns a video placeholder without a third-party iframe", async () => {
    const response = await route.POST(
      request({
        markdown: "@video: https://youtu.be/dQw4w9WgXcQ",
        embedMode: "preview",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.data.html).toContain('class="video-embed-placeholder"');
    expect(payload.data.html).toContain(
      'data-embed-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
    expect(payload.data.html).not.toContain("<iframe");
  });

  it("rejects an oversized body", async () => {
    const response = await route.POST(
      request({ markdown: "x".repeat(MAX_POST_BODY_LENGTH + 1), embedMode: "preview" }),
    );
    expect(response.status).toBe(413);
  });

  it("accepts only preview embed mode", async () => {
    const response = await route.POST(request({ markdown: "text", embedMode: "public" }));
    expect(response.status).toBe(400);
  });

  it("rate limits repeated rendering", async () => {
    for (let index = 0; index < 60; index += 1) {
      const response = await route.POST(request({ markdown: "text", embedMode: "preview" }));
      expect(response.status).toBe(200);
    }
    const blocked = await route.POST(request({ markdown: "text", embedMode: "preview" }));
    expect(blocked.status).toBe(429);
  });
});
