import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: "production",
    APP_URL: "https://artist.example",
    SECURITY_HSTS_ENABLED: false,
  },
  getConfiguredStorageCspSources: vi.fn(),
  getPublicCspRuntimeConfig: vi.fn(),
  readPublicSecurityState: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => mocks.env,
}));
vi.mock("@/modules/site/public-security", () => ({
  getConfiguredStorageCspSources: mocks.getConfiguredStorageCspSources,
  getPublicCspRuntimeConfig: mocks.getPublicCspRuntimeConfig,
  readPublicSecurityState: mocks.readPublicSecurityState,
}));

import { config, middleware } from "./middleware";

const emptySources = {
  script: [],
  image: [],
  media: [],
  connect: [],
  frame: [],
};

function request(pathname = "/", headers?: HeadersInit) {
  return new NextRequest(`https://artist.example${pathname}`, { headers });
}

function forwardedRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("document security middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.NODE_ENV = "production";
    mocks.env.APP_URL = "https://artist.example";
    mocks.env.SECURITY_HSTS_ENABLED = false;
    mocks.getPublicCspRuntimeConfig.mockResolvedValue({
      effectiveMode: "enforce",
      revision: "revision-one",
      sources: emptySources,
    });
    mocks.readPublicSecurityState.mockResolvedValue({
      effectiveMode: "report-only",
      revision: "revision-one",
    });
    mocks.getConfiguredStorageCspSources.mockResolvedValue([
      "https://artist-media.objects.example",
    ]);
  });

  it("excludes public XML/text crawler routes while matching public pages", () => {
    const matcher = config.matcher[0]!;
    const pattern = new RegExp(`^${matcher}$`);

    expect(pattern.test("/feed.xml")).toBe(false);
    expect(pattern.test("/robots.txt")).toBe(false);
    expect(pattern.test("/sitemap.xml")).toBe(false);
    expect(pattern.test("/sitemaps/static.xml")).toBe(false);
    expect(pattern.test("/sitemaps/posts/0.xml")).toBe(false);
    expect(pattern.test("/posts")).toBe(true);
    expect(pattern.test("/posts/public-title")).toBe(true);
    expect(pattern.test("/admin")).toBe(true);
  });

  it("uses one nonce and policy for the forwarded request and browser response", async () => {
    const response = await middleware(request());
    const responsePolicy = response.headers.get("content-security-policy");
    const requestPolicy = forwardedRequestHeader(response, "content-security-policy");
    const nonce = forwardedRequestHeader(response, "x-nonce");

    expect(responsePolicy).toBeTruthy();
    expect(requestPolicy).toBe(responsePolicy);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(responsePolicy).toContain(`'nonce-${nonce}'`);
    expect(forwardedRequestHeader(response, "x-csp-config-revision")).toBe("revision-one");
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("generates a different nonce for each request", async () => {
    const first = await middleware(request());
    const second = await middleware(request());

    expect(forwardedRequestHeader(first, "x-nonce")).not.toBe(
      forwardedRequestHeader(second, "x-nonce"),
    );
  });

  it("switches only the browser header in report-only mode", async () => {
    mocks.getPublicCspRuntimeConfig.mockResolvedValue({
      effectiveMode: "report-only",
      revision: "legacy",
      sources: emptySources,
    });

    const response = await middleware(request());
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toBe(
      forwardedRequestHeader(response, "content-security-policy"),
    );
  });

  it("sets the required global headers without COEP or CORS expansion", async () => {
    const response = await middleware(request());

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps public integration sources out of admin while preserving rollout mode", async () => {
    mocks.getPublicCspRuntimeConfig.mockResolvedValue({
      effectiveMode: "report-only",
      revision: "public-revision",
      sources: { ...emptySources, script: ["https://analytics.example"] },
    });

    const response = await middleware(request("/admin/site"));
    const policy = response.headers.get("content-security-policy-report-only");

    expect(mocks.getPublicCspRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.readPublicSecurityState).toHaveBeenCalledTimes(1);
    expect(policy).not.toContain("https://analytics.example");
    expect(policy).toContain("img-src 'self' data: https://artist-media.objects.example");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(forwardedRequestHeader(response, "x-public-security-render")).toBeNull();
  });

  it("adds public integration sources and render marker to supporter wall", async () => {
    mocks.getPublicCspRuntimeConfig.mockResolvedValue({
      effectiveMode: "enforce",
      revision: "public-revision",
      sources: {
        ...emptySources,
        script: ["https://plausible.io", "https://custom-analytics.example"],
        connect: ["https://analytics.umami.is"],
      },
    });

    const response = await middleware(request("/supporters"));
    const policy = response.headers.get("content-security-policy");

    expect(mocks.getPublicCspRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(mocks.readPublicSecurityState).not.toHaveBeenCalled();
    expect(policy).toContain("https://plausible.io");
    expect(policy).toContain("https://custom-analytics.example");
    expect(policy).toContain("https://analytics.umami.is");
    expect(forwardedRequestHeader(response, "x-csp-config-revision")).toBe("public-revision");
    expect(forwardedRequestHeader(response, "x-public-security-render")).toBe("1");
  });

  it("keeps integrations out of login and member documents without overriding rollout mode", async () => {
    for (const pathname of ["/login", "/me", "/checkout", "/checkout/tier-id"]) {
      const response = await middleware(request(pathname));

      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("content-security-policy-report-only")).toBeTruthy();
      expect(forwardedRequestHeader(response, "x-public-security-render")).toBeNull();
    }
    expect(mocks.getPublicCspRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.readPublicSecurityState).toHaveBeenCalledTimes(4);
  });

  it("preserves report-only mode when optional storage-source derivation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getConfiguredStorageCspSources.mockRejectedValue(new Error("storage unavailable"));

    const response = await middleware(request("/login"));

    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toBeTruthy();
    expect(forwardedRequestHeader(response, "x-csp-config-revision")).toBe("revision-one");
    expect(response.headers.get("content-security-policy-report-only")).not.toContain(
      "https://artist-media.objects.example",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[security] failed to derive storage CSP sources; using same-origin only",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("removes a client-supplied public rendering marker from admin requests", async () => {
    const response = await middleware(request("/admin/site", { "x-public-security-render": "1" }));

    expect(forwardedRequestHeader(response, "x-public-security-render")).toBeNull();
  });

  it("fails safely when APP_URL is malformed", async () => {
    mocks.env.APP_URL = "not a URL";
    const response = await middleware(request());

    expect(response.headers.get("content-security-policy")).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("emits HSTS only when explicitly enabled", async () => {
    expect((await middleware(request())).headers.get("strict-transport-security")).toBeNull();

    mocks.env.SECURITY_HSTS_ENABLED = true;
    expect((await middleware(request())).headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("marks notification unsubscribe pages as non-cacheable and non-indexable", async () => {
    const response = await middleware(request("/unsubscribe/notifications/token-value"));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
