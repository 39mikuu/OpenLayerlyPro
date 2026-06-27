import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  requestHeaders: new Headers(),
  securityRevision: "current-revision",
}));

vi.mock("./globals.css", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (mocks.cookieValue ? { value: mocks.cookieValue } : undefined),
  }),
  headers: async () => mocks.requestHeaders,
}));
vi.mock("@/components/i18n-provider", () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/modules/i18n/server", () => ({
  resolveLocale: async () => "en",
}));
vi.mock("@/modules/site", () => ({
  getPublicSiteInfo: async () => ({
    siteName: "Security test",
    siteIconFileId: null,
  }),
}));
vi.mock("@/modules/site/public-security", () => ({
  canRenderIntegrationRevision: (
    requestRevision: string | null,
    currentRevision: string,
    nonce: string | null,
  ) => Boolean(nonce && requestRevision === currentRevision),
  escapeInlineScriptBody: (value: string) => value,
  getPublicRenderConfig: async () => ({
    revision: mocks.securityRevision,
    verificationMeta: [{ name: "google-site-verification", content: "verification-token" }],
    integrationPlans: [
      {
        id: "revision-race",
        placement: "head",
        inlineCode: "window.__revisionRaceIntegration = true",
        data: {},
      },
    ],
  }),
}));
vi.mock("@/modules/theme", () => ({
  THEME_INIT_SCRIPT: "window.__themeInitialized = true",
  THEME_MODE_COOKIE: "theme_mode",
  buildColorPresetCss: () => null,
  darkClassFromMode: () => "",
  getActiveTheme: async () => ({}),
  getThemeConfig: async () => ({}),
}));

import RootLayout from "./layout";

describe("root CSP revision fence", () => {
  beforeEach(() => {
    mocks.securityRevision = "current-revision";
    mocks.requestHeaders = new Headers({
      "x-nonce": "request-nonce",
      "x-csp-config-revision": "middleware-revision",
      "x-public-security-render": "1",
    });
  });

  it("skips integration scripts when middleware and render revisions differ", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const html = renderToStaticMarkup(
      await RootLayout({ children: createElement("main", null, "page") }),
    );

    expect(html).not.toContain("__revisionRaceIntegration");
    expect(html).toContain("__themeInitialized");
    expect(html).toContain('nonce="request-nonce"');
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("public integration revision changed during request"),
    );
    consoleWarn.mockRestore();
  });

  it("renders the integration only when the request revision matches", async () => {
    mocks.requestHeaders.set("x-csp-config-revision", "current-revision");

    const html = renderToStaticMarkup(
      await RootLayout({ children: createElement("main", null, "page") }),
    );

    expect(html).toContain("window.__revisionRaceIntegration = true");
    expect(html).toContain('nonce="request-nonce"');
  });
});
