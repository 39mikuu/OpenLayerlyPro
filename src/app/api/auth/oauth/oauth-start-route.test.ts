import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginOAuthLogin: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ APP_URL: "https://site.example/base", NODE_ENV: "test" }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/auth/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/oauth")>();
  return { ...actual, beginOAuthLogin: mocks.beginOAuthLogin };
});

import { GET as githubStartGET } from "@/app/api/auth/oauth/github/start/route";
import { GET as googleStartGET } from "@/app/api/auth/oauth/google/start/route";

describe("OAuth start retry target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockReturnValue(true);
    mocks.beginOAuthLogin.mockResolvedValue({
      authorizationUrl: "https://provider.example/authorize",
      browserBinding: "binding",
    });
  });

  it.each(["google", "github"] as const)(
    "stores a validated %s target for callback failures",
    async (provider) => {
      const req = new NextRequest(
        `https://site.example/base/api/auth/oauth/${provider}/start?next=%2Fcheckout%2Ftier-1`,
      );
      const response =
        provider === "google" ? await googleStartGET(req) : await githubStartGET(req);

      expect(response.status).toBe(302);
      expect(mocks.beginOAuthLogin).toHaveBeenCalledWith(
        provider,
        expect.objectContaining({ redirectPath: "/checkout/tier-1" }),
      );
      expect(response.cookies.get(`olp_oauth_next_${provider}`)?.value).toBe("/checkout/tier-1");
    },
  );

  it("keeps next on a rate-limited start without accepting external URLs", async () => {
    mocks.rateLimit.mockReturnValue(false);
    const safe = await googleStartGET(
      new NextRequest(
        "https://site.example/base/api/auth/oauth/google/start?next=%2Fcheckout%2Ftier-1",
      ),
    );
    expect(safe.headers.get("Location")).toBe(
      "https://site.example/base/login?oauth_error=rate_limited&next=%2Fcheckout%2Ftier-1",
    );
    const external = await googleStartGET(
      new NextRequest(
        "https://site.example/base/api/auth/oauth/google/start?next=https%3A%2F%2Fevil.example",
      ),
    );
    expect(external.headers.get("Location")).toBe(
      "https://site.example/base/login?oauth_error=rate_limited",
    );
  });
});
