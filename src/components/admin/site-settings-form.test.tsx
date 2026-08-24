import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n-provider";
import { zh } from "@/modules/i18n/messages/zh";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { SiteSettingsForm } from "./site-settings-form";

function renderForm() {
  return renderToStaticMarkup(
    <I18nProvider locale="zh" messages={zh}>
      <SiteSettingsForm
        initial={{
          siteName: "OpenLayerly",
          artistName: "Artist",
          artistBio: "Bio",
          artistAvatarFileId: "avatar-file-id",
          siteLogoFileId: "logo-file-id",
          siteIconFileId: "icon-file-id",
          customFooterMarkup: '<p><a href="https://example.com">Footer</a></p>',
          legacyFooterHtml:
            '<script src="https://legacy.example/very-long-script-name.js"></script>',
          legacyFooterStatus: "needs_migration",
          siteVerification: [{ provider: "google", content: "verification-token" }],
          publicIntegrations: [],
          cspRevision: "revision",
          cspMode: "auto",
          effectiveCspMode: "report-only",
          publicSecurityConfigurationErrors: [
            "https://very-long-unbroken-origin-value.example.invalid/path/that-must-wrap",
          ],
          paymentProofApprovedRetentionDays: 30,
          socialLinks: [
            {
              name: "Example",
              url: "https://example.com/a-very-long-unbroken-social-link-value-for-mobile",
            },
          ],
        }}
      />
    </I18nProvider>,
  );
}

describe("SiteSettingsForm", () => {
  it("associates site-setting labels and help text with their controls", () => {
    const html = renderForm();

    expect(html).toContain('for="site-name"');
    expect(html).toContain('id="site-name"');
    expect(html).toContain('for="artist-avatar"');
    expect(html).toContain('id="artist-avatar"');
    expect(html).toContain('for="site-logo"');
    expect(html).toContain('aria-describedby="site-logo-description"');
    expect(html).toContain('for="site-verification-json"');
    expect(html).toContain('aria-describedby="site-verification-json-description"');
    expect(html).toContain('for="social-link-name-0"');
    expect(html).toContain('for="social-link-url-0"');
  });

  it("renders narrow-screen stacking hooks for assets, links, and actions", () => {
    const html = renderForm();

    expect(html).toContain('data-testid="site-settings-form"');
    expect(html).toContain('data-testid="site-social-link-row"');
    expect(html).toContain("sm:grid-cols-[8rem_minmax(0,1fr)_auto]");
    expect(html.match(/w-full sm:w-auto/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html.match(/sm:flex-row/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("file:max-w-full");
  });

  it("keeps long diagnostics and legacy source visible without relying on unbroken layout", () => {
    const html = renderForm();

    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("https://very-long-unbroken-origin-value.example.invalid/path");
    expect(html).toContain(
      "&lt;script src=&quot;https://legacy.example/very-long-script-name.js&quot;&gt;&lt;/script&gt;",
    );
    expect(html).not.toContain('<script src="https://legacy.example');
  });
});
