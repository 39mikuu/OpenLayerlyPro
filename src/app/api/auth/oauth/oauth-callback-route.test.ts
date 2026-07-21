import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeOAuthLogin: vi.fn(),
  cancelOAuthLogin: vi.fn(),
  createSession: vi.fn(),
  setSessionCookie: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("@/modules/auth/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/oauth")>();
  return {
    ...actual,
    completeOAuthLogin: mocks.completeOAuthLogin,
    cancelOAuthLogin: mocks.cancelOAuthLogin,
  };
});
vi.mock("@/modules/auth/session", () => ({
  createSession: mocks.createSession,
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("@/modules/i18n/server", () => ({
  resolveLocale: mocks.resolveLocale,
}));

import { GET as githubCallbackGET } from "@/app/api/auth/oauth/github/callback/route";
import { GET as googleCallbackGET } from "@/app/api/auth/oauth/google/callback/route";
import { ApiError } from "@/lib/api";

describe("OAuth callback API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveLocale.mockResolvedValue("en");
  });

  it("completes Google login and sets session cookie on success", async () => {
    mocks.completeOAuthLogin.mockResolvedValueOnce({
      user: { id: "user-google-1", email: "google@user.test" },
      redirectPath: "/posts/123",
    });
    mocks.createSession.mockResolvedValueOnce({
      token: "session-tok-1",
      expiresAt: new Date(Date.now() + 10000),
    });

    const req = new NextRequest(
      "http://localhost:3000/api/auth/oauth/google/callback?code=c&state=s",
    );
    const res = await googleCallbackGET(req);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/posts/123");
    expect(mocks.completeOAuthLogin).toHaveBeenCalledWith("google", {
      code: "c",
      state: "s",
      browserBinding: null,
      locale: "en",
    });
    expect(mocks.createSession).toHaveBeenCalledWith("user-google-1", expect.any(Object));
    expect(mocks.setSessionCookie).toHaveBeenCalledWith("session-tok-1", expect.any(Date));
  });

  it("completes GitHub login successfully", async () => {
    mocks.completeOAuthLogin.mockResolvedValueOnce({
      user: { id: "user-github-1", email: "github@user.test" },
      redirectPath: null,
    });
    mocks.createSession.mockResolvedValueOnce({
      token: "session-tok-2",
      expiresAt: new Date(Date.now() + 10000),
    });

    const req = new NextRequest(
      "http://localhost:3000/api/auth/oauth/github/callback?code=c&state=s",
    );
    const res = await githubCallbackGET(req);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/me");
  });

  it("validates and consumes state before accepting a provider denial", async () => {
    mocks.cancelOAuthLogin.mockResolvedValueOnce(undefined);
    const req = new NextRequest(
      "http://localhost:3000/api/auth/oauth/google/callback?error=access_denied&state=s",
      { headers: { cookie: "olp_oauth_bind_google=binding" } },
    );
    const res = await googleCallbackGET(req);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/login?oauth_error=denied");
    expect(mocks.cancelOAuthLogin).toHaveBeenCalledWith("google", {
      state: "s",
      browserBinding: "binding",
    });
    expect(res.headers.get("set-cookie")).toContain("olp_oauth_bind_google=");
  });

  it("does not let an unvalidated provider denial cancel the active flow", async () => {
    mocks.cancelOAuthLogin.mockRejectedValueOnce(new ApiError(400, "oauthInvalidState"));
    const req = new NextRequest(
      "http://localhost:3000/api/auth/oauth/google/callback?error=access_denied",
    );
    const res = await googleCallbackGET(req);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/login?oauth_error=state");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("handles specific ApiErrors by mapping to failure codes", async () => {
    mocks.completeOAuthLogin.mockRejectedValueOnce(new ApiError(400, "oauthEmailUnverified"));
    const req = new NextRequest(
      "http://localhost:3000/api/auth/oauth/google/callback?code=c&state=s",
    );
    const res = await googleCallbackGET(req);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/login?oauth_error=email");
  });

  it("handles other errors by mapping to generic failed", async () => {
    mocks.completeOAuthLogin.mockRejectedValueOnce(new Error("network fail"));
    const req = new NextRequest(
      "http://localhost:3000/api/auth/oauth/google/callback?code=c&state=s",
    );
    const res = await googleCallbackGET(req);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/login?oauth_error=failed");
  });
});
