import { describe, expect, it } from "vitest";

import { isPublicIntegrationDocument } from "./public-integration-paths";
import {
  buildFooterHtml,
  buildIntegrationRuntime,
  buildVerificationMeta,
  canRenderIntegrationRevision,
  classifyLegacyFooter,
  escapeInlineScriptBody,
  parsePublicSecuritySettings,
  publicIntegrationsSchema,
  resolveStorageCspSources,
  sanitizeFooterMarkup,
  siteVerificationSchema,
} from "./public-security";

describe("safe public footer markup", () => {
  it("preserves display markup while removing executable content and policy attributes", () => {
    const cleaned = sanitizeFooterMarkup(
      '<p class="filing">ICP <a href="https://example.com" target="_blank">record</a></p>' +
        '<script nonce="attacker">alert(1)</script>' +
        '<img src="https://tracker.example/pixel">' +
        '<span onclick="alert(1)" style="color:red">safe text</span>',
    );

    expect(cleaned).toContain('<p class="filing">');
    expect(cleaned).toContain('rel="noopener noreferrer"');
    expect(cleaned).toContain("safe text");
    expect(cleaned).not.toMatch(/script|nonce|onclick|style=|<img/);
  });

  it("classifies empty, safe, and executable legacy values", () => {
    expect(classifyLegacyFooter("")).toBe("empty");
    expect(classifyLegacyFooter('<p><a href="https://example.com">ICP</a></p>')).toBe(
      "safe_markup",
    );
    expect(classifyLegacyFooter("<script>window.analytics=true</script>")).toBe("needs_migration");
    expect(classifyLegacyFooter('<p onclick="run()">text</p>')).toBe("needs_migration");
  });

  it("classifies harmless serialization variants semantically", () => {
    for (const markup of [
      "<br>",
      "<br/>",
      "<P>ICP</P>",
      "<p>unclosed",
      "<a href='https://example.com' target='_blank'>record</a>",
    ]) {
      expect(classifyLegacyFooter(markup)).toBe("safe_markup");
    }
    for (const markup of [
      '<a href="//tracker.example">protocol relative</a>',
      '<a href="javascript&#58;alert(1)">script URL</a>',
      '<p style="color:red">style</p>',
      "<meta http-equiv='refresh'>",
    ]) {
      expect(classifyLegacyFooter(markup)).toBe("needs_migration");
    }
  });

  it("keeps executable legacy content only in report-only rollout", () => {
    const legacy = "<script>window.analytics=true</script>";
    const auto = parsePublicSecuritySettings({ custom_footer_html: legacy });
    expect(auto.effectiveMode).toBe("report-only");
    expect(auto.footerHtml).toBe(legacy);

    const safe = parsePublicSecuritySettings({ custom_footer_html: "<p>ICP</p>" });
    expect(safe.effectiveMode).toBe("enforce");
    expect(safe.footerHtml).toBe("<p>ICP</p>");
    expect(
      buildFooterHtml({
        customFooterMarkup: "",
        legacyFooterHtml: legacy,
        legacyFooterStatus: "needs_migration",
        effectiveMode: "enforce",
      }),
    ).toBe("");
  });

  it("preserves executable legacy behavior beside new safe markup until enforcement", () => {
    const legacy = "<script>window.analytics=true</script>";
    expect(
      buildFooterHtml({
        customFooterMarkup: "<p>New filing text</p>",
        legacyFooterHtml: legacy,
        legacyFooterStatus: "needs_migration",
        effectiveMode: "report-only",
      }),
    ).toBe(`<p>New filing text</p>\n${legacy}`);
    expect(
      buildFooterHtml({
        customFooterMarkup: "<p>New filing text</p>",
        legacyFooterHtml: legacy,
        legacyFooterStatus: "needs_migration",
        effectiveMode: "enforce",
      }),
    ).toBe("<p>New filing text</p>");
  });
});

describe("structured site verification", () => {
  it("maps known providers and permits a constrained custom meta name", () => {
    const records = siteVerificationSchema.parse([
      { provider: "google", content: "google-token" },
      { provider: "custom", name: "facebook-domain-verification", content: "fb-token" },
    ]);
    expect(buildVerificationMeta(records)).toEqual([
      { name: "google-site-verification", content: "google-token" },
      { name: "facebook-domain-verification", content: "fb-token" },
    ]);
  });

  it("rejects http-equiv and raw tag fields", () => {
    expect(
      siteVerificationSchema.safeParse([
        { provider: "custom", name: "http-equiv", content: "refresh" },
      ]).success,
    ).toBe(false);
    expect(
      siteVerificationSchema.safeParse([
        { provider: "google", content: "token", tag: "<meta http-equiv=refresh>" },
      ]).success,
    ).toBe(false);
  });
});

describe("public integration registry", () => {
  it.each([
    ["/", true],
    ["/posts", true],
    ["/posts/x", true],
    ["/tiers", true],
    ["/me", false],
    ["/admin", false],
    ["/checkout/x", false],
    ["/login", false],
  ])("shares the public integration route matcher for %s", (pathname, expected) => {
    expect(isPublicIntegrationDocument(pathname)).toBe(expected);
  });

  it("fences rendering when middleware and layout revisions differ", () => {
    expect(canRenderIntegrationRevision("revision-a", "revision-a", "nonce")).toBe(true);
    expect(canRenderIntegrationRevision("revision-a", "revision-b", "nonce")).toBe(false);
    expect(canRenderIntegrationRevision("revision-a", "revision-a", null)).toBe(false);
  });

  it("derives Plausible rendering and CSP origins from one parsed record", () => {
    const integrations = publicIntegrationsSchema.parse([
      {
        id: "analytics",
        provider: "plausible",
        domain: "artist.example",
        scriptUrl: "https://stats.example/js/script.js",
        apiOrigin: "https://stats.example",
      },
    ]);
    const runtime = buildIntegrationRuntime(integrations);

    expect(runtime.plans).toEqual([
      {
        id: "analytics",
        placement: "head",
        src: "https://stats.example/js/script.js",
        defer: true,
        data: { domain: "artist.example", api: "https://stats.example/api/event" },
      },
    ]);
    expect(runtime.sources.script).toEqual(["https://stats.example"]);
    expect(runtime.sources.connect).toEqual(["https://stats.example"]);
  });

  it("derives Umami cloud rendering and CSP origins from one parsed record", () => {
    const websiteId = "11111111-1111-4111-8111-111111111111";
    const integrations = publicIntegrationsSchema.parse([
      {
        id: "analytics",
        provider: "umami",
        websiteId,
      },
    ]);
    const runtime = buildIntegrationRuntime(integrations);

    expect(runtime.plans).toEqual([
      {
        id: "analytics",
        placement: "head",
        src: "https://cloud.umami.is/script.js",
        defer: true,
        data: { "website-id": websiteId, "auto-track": "false" },
      },
      {
        id: "analytics-manual-pageview",
        placement: "head",
        inlineCode: expect.any(String),
        data: {},
      },
    ]);
    expect(runtime.sources.script).toEqual(["https://cloud.umami.is"]);
    expect(runtime.sources.connect).toEqual(["https://cloud.umami.is"]);
  });

  it("emits host-url for an explicit same-origin Umami apiOrigin (subpath script)", () => {
    const websiteId = "33333333-3333-4333-8333-333333333333";
    const integrations = publicIntegrationsSchema.parse([
      {
        id: "subpath-analytics",
        provider: "umami",
        websiteId,
        scriptUrl: "https://site.example/stats/script.js",
        apiOrigin: "https://site.example",
      },
    ]);
    const runtime = buildIntegrationRuntime(integrations);

    expect(runtime.plans[0]?.data).toEqual({
      "website-id": websiteId,
      "auto-track": "false",
      // Explicit apiOrigin must always emit host-url: otherwise the tracker
      // derives /stats/api/send from the script directory and loses events.
      "host-url": "https://site.example",
    });
    expect(runtime.sources.connect).toEqual(["https://site.example"]);
  });

  it("tracks manual Umami pageviews with the current URL, not the cached one", () => {
    const integrations = publicIntegrationsSchema.parse([
      {
        id: "analytics",
        provider: "umami",
        websiteId: "44444444-4444-4444-8444-444444444444",
      },
    ]);
    const runtime = buildIntegrationRuntime(integrations);
    const inline = runtime.plans[1]?.inlineCode ?? "";
    // With data-auto-track=false the tracker's cached currentUrl goes stale;
    // the companion must pass an explicit payload with location-derived url.
    expect(inline).toContain("location.pathname+location.search");
    expect(inline).toContain("document.title");
    expect(inline).not.toContain("track();");
  });

  it("derives Umami custom host rendering and CSP origins from explicit origins", () => {
    const websiteId = "22222222-2222-4222-8222-222222222222";
    const integrations = publicIntegrationsSchema.parse([
      {
        id: "self-hosted-analytics",
        provider: "umami",
        websiteId,
        scriptUrl: "https://cdn.example/umami/script.js",
        apiOrigin: "https://analytics.example",
      },
    ]);
    const runtime = buildIntegrationRuntime(integrations);

    expect(runtime.plans).toEqual([
      {
        id: "self-hosted-analytics",
        placement: "head",
        src: "https://cdn.example/umami/script.js",
        defer: true,
        data: {
          "website-id": websiteId,
          "auto-track": "false",
          "host-url": "https://analytics.example",
        },
      },
      {
        id: "self-hosted-analytics-manual-pageview",
        placement: "head",
        inlineCode: expect.any(String),
        data: {},
      },
    ]);
    expect(runtime.sources.script).toEqual(["https://cdn.example"]);
    expect(runtime.sources.connect).toEqual(["https://analytics.example"]);
  });

  it("does not render disabled Umami integrations", () => {
    const integrations = publicIntegrationsSchema.parse([
      {
        id: "analytics",
        provider: "umami",
        enabled: false,
        websiteId: "33333333-3333-4333-8333-333333333333",
      },
    ]);

    expect(buildIntegrationRuntime(integrations)).toMatchObject({
      plans: [],
      sources: { script: [], connect: [] },
    });
  });

  it("renders nothing when public integrations are unconfigured", () => {
    expect(buildIntegrationRuntime(publicIntegrationsSchema.parse([]))).toMatchObject({
      plans: [],
      sources: { script: [], image: [], connect: [], frame: [] },
    });
  });

  it("rejects invalid Umami website ids and script URLs", () => {
    for (const integration of [
      {
        id: "bad-website",
        provider: "umami",
        websiteId: "not-a-uuid",
      },
      {
        id: "bad-script",
        provider: "umami",
        websiteId: "44444444-4444-4444-8444-444444444444",
        scriptUrl: "http://analytics.example/script.js",
      },
    ]) {
      expect(publicIntegrationsSchema.safeParse([integration]).success).toBe(false);
    }
  });

  it("surfaces invalid stored Umami configuration as a public security configuration error", () => {
    const state = parsePublicSecuritySettings({
      public_integrations: [{ id: "analytics", provider: "umami" }],
    });

    expect(state.publicIntegrations).toEqual([]);
    expect(state.configurationErrors).toEqual([expect.stringContaining("public_integrations:")]);
  });

  it("derives custom rendering and all CSP origins from the registered adapter", () => {
    const integrations = publicIntegrationsSchema.parse([
      {
        id: "custom-analytics",
        provider: "custom",
        placement: "body",
        src: "https://scripts.example/analytics.js",
        data: { site: "artist" },
        csp: {
          script: ["https://worker.example"],
          connect: ["https://events.example"],
          image: ["https://pixel.example"],
          frame: ["https://frame.example"],
        },
      },
    ]);
    const runtime = buildIntegrationRuntime(integrations);

    expect(runtime.plans).toEqual([
      expect.objectContaining({
        id: "custom-analytics",
        placement: "body",
        src: "https://scripts.example/analytics.js",
      }),
    ]);
    expect(runtime.sources).toMatchObject({
      script: ["https://scripts.example", "https://worker.example"],
      connect: ["https://events.example"],
      image: ["https://pixel.example"],
      frame: ["https://frame.example"],
    });
  });

  it("rejects providers that are absent from the integration adapter registry", () => {
    expect(
      publicIntegrationsSchema.safeParse([
        { id: "unknown", provider: "missing", src: "https://scripts.example/a.js" },
      ]).success,
    ).toBe(false);
  });

  it("rejects broad, non-HTTPS, credentialed, and undeclared custom input", () => {
    for (const integration of [
      {
        id: "wildcard",
        provider: "custom",
        src: "https://cdn.example/script.js",
        csp: { script: ["https://*.example.com"] },
      },
      { id: "http", provider: "custom", src: "http://cdn.example/script.js" },
      { id: "credentials", provider: "custom", src: "https://user:pass@cdn.example/a.js" },
      {
        id: "nonce",
        provider: "custom",
        inlineCode: "run()",
        nonce: "administrator-controlled",
      },
    ]) {
      expect(publicIntegrationsSchema.safeParse([integration]).success).toBe(false);
    }
  });

  it("escapes script-closing text and Unicode separators in trusted inline code", () => {
    expect(escapeInlineScriptBody("</script>\u2028next()\u2029")).toBe(
      "<\\/script>\\u2028next()\\u2029",
    );
  });
});

describe("storage CSP sources", () => {
  it("keeps the signed S3 origin for historical objects while uploads use local storage", async () => {
    await expect(
      resolveStorageCspSources(
        {
          driver: "local",
          s3Configured: true,
          endpoint: "https://objects.example",
          region: "auto",
          bucket: "artist-media",
          accessKeyId: "test-access",
          secretAccessKey: "test-secret",
          forcePathStyle: false,
        },
        ["legacy-media"],
      ),
    ).resolves.toEqual([
      "https://artist-media.objects.example",
      "https://legacy-media.objects.example",
    ]);
  });

  it("adds no storage source when S3 credentials are unavailable", async () => {
    await expect(
      resolveStorageCspSources({
        driver: "local",
        s3Configured: false,
        endpoint: undefined,
        region: "auto",
        bucket: undefined,
        accessKeyId: undefined,
        secretAccessKey: undefined,
        forcePathStyle: true,
      }),
    ).resolves.toEqual([]);
  });
});
