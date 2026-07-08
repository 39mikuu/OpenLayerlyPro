import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type AdminConfigSource,
  ConfigSourceSummary,
} from "@/components/admin/config-source-summary";
import { I18nProvider } from "@/components/i18n-provider";
import type { Locale } from "@/modules/i18n";

function renderSummary(
  locale: Locale,
  props: {
    connectionTestUsesSavedConfig?: boolean;
    hasEnvironmentImportAction?: boolean;
    hasSensitiveFields?: boolean;
    source: AdminConfigSource;
    supportsEnvironmentFallback: boolean;
  },
) {
  return renderToStaticMarkup(
    <I18nProvider locale={locale}>
      <ConfigSourceSummary {...props} />
    </I18nProvider>,
  );
}

describe("ConfigSourceSummary", () => {
  it("explains that environment import is draft-only and tests use saved config", () => {
    const html = renderSummary("en", {
      connectionTestUsesSavedConfig: true,
      hasEnvironmentImportAction: true,
      hasSensitiveFields: true,
      source: "environment",
      supportsEnvironmentFallback: true,
    });

    expect(html).toContain("Current source");
    expect(html).toContain("Environment variables");
    expect(html).toContain("Import from environment only fills this form");
    expect(html).toContain("Connection tests use the saved effective configuration");
    expect(html).toContain(
      "Leaving a secret field blank keeps the existing saved or environment value",
    );
  });

  it("distinguishes database-only integrations from env fallback settings", () => {
    const html = renderSummary("en", {
      hasSensitiveFields: true,
      source: "none",
      supportsEnvironmentFallback: false,
    });

    expect(html).toContain("No saved configuration");
    expect(html).toContain("This integration has no environment-variable fallback");
    expect(html).toContain("Leaving a secret field blank keeps the existing saved value");
    expect(html).not.toContain("saved or environment value");
  });

  it("does not describe an environment import action when the form does not have one", () => {
    const html = renderSummary("en", {
      source: "environment",
      supportsEnvironmentFallback: true,
    });

    expect(html).toContain("Use environment variables clears the saved admin override");
    expect(html).not.toContain("Import from environment only fills this form");
  });

  it("has localized source labels for zh and ja", () => {
    expect(
      renderSummary("zh", { source: "database", supportsEnvironmentFallback: true }),
    ).toContain("后台配置");
    expect(
      renderSummary("ja", { source: "database", supportsEnvironmentFallback: true }),
    ).toContain("管理画面の設定");
  });
});
