import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Translate } from "@/modules/i18n";
import type { SupporterWallViewModel } from "@/modules/supporter-wall";
import { blogTheme } from "@/themes/blog";
import { builtinTheme } from "@/themes/builtin";
import { wordpressTheme } from "@/themes/wordpress";

const t: Translate = (key) => key;

const maliciousDedication =
  '<script>alert("x")</script><a href="https://example.com">bad</a> https://example.com';

function view(overrides: Partial<SupporterWallViewModel> = {}): SupporterWallViewModel {
  return {
    supporters: [
      {
        displayName: "Plain Fan",
        tierName: "Gold",
        dedication: maliciousDedication,
      },
    ],
    ...overrides,
  };
}

describe("theme supporter wall slot", () => {
  it.each([
    ["builtin", builtinTheme],
    ["blog", blogTheme],
    ["wordpress", wordpressTheme],
  ] as const)(
    "renders dedication text without linkification or HTML activation for %s",
    (_name, theme) => {
      const html = renderToStaticMarkup(
        createElement(theme.components.SupporterWall, { t, view: view() }),
      );

      expect(html).toContain("Plain Fan");
      expect(html).toContain("Gold");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&lt;a href=&quot;https://example.com&quot;&gt;bad&lt;/a&gt;");
      expect(html).toContain("https://example.com");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<a ");
    },
  );

  it.each([
    ["builtin", builtinTheme],
    ["blog", blogTheme],
    ["wordpress", wordpressTheme],
  ] as const)("renders an empty state for %s", (_name, theme) => {
    const html = renderToStaticMarkup(
      createElement(theme.components.SupporterWall, { t, view: view({ supporters: [] }) }),
    );

    expect(html).toContain("supporters.empty");
  });
});
