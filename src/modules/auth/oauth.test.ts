import { describe, expect, it } from "vitest";

import { getOAuthApiBasePath, getOAuthCookiePath } from "./oauth";

describe("getOAuthApiBasePath", () => {
  it("is empty for a root APP_URL", () => {
    expect(getOAuthApiBasePath("https://site.example")).toBe("");
    expect(getOAuthApiBasePath("https://site.example/")).toBe("");
  });

  it("preserves a configured base path", () => {
    expect(getOAuthApiBasePath("https://site.example/base")).toBe("/base");
    expect(getOAuthApiBasePath("https://site.example/base///")).toBe("/base");
  });
});

describe("getOAuthCookiePath", () => {
  it("scopes the cookie to /api/auth/oauth when APP_URL has no base path", () => {
    expect(getOAuthCookiePath("https://site.example")).toBe("/api/auth/oauth");
    expect(getOAuthCookiePath("https://site.example/")).toBe("/api/auth/oauth");
  });

  it("preserves the APP_URL base path so the browser actually sends the cookie back", () => {
    expect(getOAuthCookiePath("https://site.example/base")).toBe("/base/api/auth/oauth");
    expect(getOAuthCookiePath("https://site.example/base///")).toBe("/base/api/auth/oauth");
  });
});
