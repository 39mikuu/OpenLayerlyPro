import { afterEach, describe, expect, it, vi } from "vitest";

const originalMode = process.env.SECURITY_CSP_MODE;

async function parseWithMode(mode: "auto" | "report-only" | "enforce") {
  process.env.SECURITY_CSP_MODE = mode;
  vi.resetModules();
  const { parsePublicSecuritySettings } = await import("./public-security");
  return parsePublicSecuritySettings({
    custom_footer_markup: "<p>New filing</p>",
    custom_footer_html: "<script>window.legacy=true</script>",
  });
}

afterEach(() => {
  if (originalMode === undefined) delete process.env.SECURITY_CSP_MODE;
  else process.env.SECURITY_CSP_MODE = originalMode;
  vi.resetModules();
});

describe("persisted legacy rollout modes", () => {
  it.each(["auto", "report-only"] as const)(
    "preserves executable legacy behavior in %s mode",
    async (mode) => {
      const state = await parseWithMode(mode);

      expect(state.effectiveMode).toBe("report-only");
      expect(state.footerHtml).toBe("<p>New filing</p>\n<script>window.legacy=true</script>");
      expect(state.legacyFooterHtml).toBe("<script>window.legacy=true</script>");
    },
  );

  it("blocks executable legacy behavior in enforce mode without deleting the original", async () => {
    const state = await parseWithMode("enforce");

    expect(state.effectiveMode).toBe("enforce");
    expect(state.footerHtml).toBe("<p>New filing</p>");
    expect(state.legacyFooterHtml).toBe("<script>window.legacy=true</script>");
    expect(state.legacyFooterStatus).toBe("needs_migration");
  });
});
