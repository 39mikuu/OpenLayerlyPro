import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginOAuthLogin: vi.fn(),
  requireAdmin: vi.fn(),
  readJsonWithLimit: vi.fn(),
  saveOAuthProviderConfig: vi.fn(),
  getOAuthProviderAdminView: vi.fn(),
  clearOAuthProviderConfig: vi.fn(),
}));

vi.mock("@/modules/auth/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/oauth")>();
  return {
    ...actual,
    beginOAuthLogin: mocks.beginOAuthLogin,
  };
});
vi.mock("@/modules/auth/session", () => ({
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/request-body", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...actual,
    readJsonWithLimit: mocks.readJsonWithLimit,
  };
});
vi.mock("@/modules/config/oauth", () => ({
  saveOAuthProviderConfig: mocks.saveOAuthProviderConfig,
  getOAuthProviderAdminView: mocks.getOAuthProviderAdminView,
  clearOAuthProviderConfig: mocks.clearOAuthProviderConfig,
  oauthProviderConfigSchema: { parse: (x: unknown) => x },
}));

import {
  DELETE as configGoogleDELETE,
  GET as configGoogleGET,
  PUT as configGooglePUT,
} from "@/app/api/admin/config/oauth/google/route";
import { GET as startGithubGET } from "@/app/api/auth/oauth/github/start/route";
import { GET as startGoogleGET } from "@/app/api/auth/oauth/google/start/route";

describe("OAuth routing & config endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles Google start authorization redirect", async () => {
    mocks.beginOAuthLogin.mockResolvedValueOnce({
      authorizationUrl: "https://google.auth/url?state=s",
      browserBinding: "mock-binding",
    });
    const req = new NextRequest("http://localhost:3000/api/auth/oauth/google/start?next=/posts");
    const res = await startGoogleGET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://google.auth/url?state=s");
    expect(mocks.beginOAuthLogin).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({
        redirectPath: "/posts",
      }),
    );
  });

  it("handles GitHub start authorization redirect", async () => {
    mocks.beginOAuthLogin.mockResolvedValueOnce({
      authorizationUrl: "https://github.auth/url",
      browserBinding: "mock-binding",
    });
    const req = new NextRequest("http://localhost:3000/api/auth/oauth/github/start");
    const res = await startGithubGET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://github.auth/url");
  });

  it("admin config endpoints require authentication and call config actions", async () => {
    mocks.getOAuthProviderAdminView.mockResolvedValueOnce({
      enabled: true,
      clientId: "client-id",
      configured: true,
      clientSecretSet: true,
      hasDbOverride: true,
    });

    const res = await configGoogleGET();
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);

    const body = (await res.json()) as { data: { clientId: string } };
    expect(body.data).toMatchObject({ clientId: "client-id" });

    // PUT
    mocks.readJsonWithLimit.mockResolvedValueOnce({
      enabled: true,
      clientId: "new-id",
      clientSecret: "new-sec",
    });
    mocks.getOAuthProviderAdminView.mockResolvedValueOnce({
      enabled: true,
      clientId: "new-id",
      configured: true,
      clientSecretSet: true,
      hasDbOverride: true,
    });
    const putReq = new NextRequest("http://localhost:3000/api/admin/config/oauth/google", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const putRes = await configGooglePUT(putReq);
    expect(putRes.status).toBe(200);
    expect(mocks.saveOAuthProviderConfig).toHaveBeenCalledWith("google", {
      enabled: true,
      clientId: "new-id",
      clientSecret: "new-sec",
    });

    // DELETE
    const delRes = await configGoogleDELETE();
    expect(delRes.status).toBe(200);
    expect(mocks.clearOAuthProviderConfig).toHaveBeenCalledWith("google");
  });
});
