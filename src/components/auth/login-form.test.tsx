import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/i18n-provider", () => ({ useT: () => (key: string) => key }));

import { LoginForm } from "./login-form";

const codePolicy = { loginCodeLength: 16, loginCodePattern: "^[0-9A-HJKMNP-TV-Z]{16}$" };

describe("login form semantics", () => {
  it("submits admin credentials through one form", () => {
    const html = renderToStaticMarkup(createElement(LoginForm, { mode: "admin", ...codePolicy }));
    expect(html).toContain("<form");
    expect(html).toContain('type="submit"');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
  });

  it("keeps code as the default action and Magic Link as a separate button", () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, {
        mode: "fan",
        magicLinkEnabled: true,
        magicLinkNext: "/checkout/tier-1",
        googleOAuthEnabled: true,
        ...codePolicy,
      }),
    );
    expect(html).toContain("<form");
    expect(html).toContain('type="submit"');
    expect(html).toContain('type="button"');
    expect(html).toContain("/api/auth/oauth/google/start?next=%2Fcheckout%2Ftier-1");
  });

  it("does not put external next URLs into an OAuth start link", () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, {
        mode: "fan",
        googleOAuthEnabled: true,
        oauthNext: "https://evil.example",
        ...codePolicy,
      }),
    );
    expect(html).toContain('href="/api/auth/oauth/google/start"');
    expect(html).not.toContain("evil.example");
  });

  it("prefixes OAuth entry points on a subpath deployment", () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, {
        mode: "fan",
        googleOAuthEnabled: true,
        oauthNext: "/checkout/tier-1",
        oauthBasePath: "/base",
        ...codePolicy,
      }),
    );
    expect(html).toContain("/base/api/auth/oauth/google/start?next=%2Fcheckout%2Ftier-1");
  });
});
