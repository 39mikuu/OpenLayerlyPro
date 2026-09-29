import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Translate } from "@/modules/i18n";
import type { TiersView } from "@/modules/theme/types";

import { Tiers } from "./tiers";

const t: Translate = (key) => key;
const view: TiersView = {
  publicBasePath: "/base",
  isLoggedIn: false,
  activeMembership: null,
  tiers: [
    {
      id: "tier-1",
      name: "Supporter",
      priceLabel: "$5",
      description: null,
      durationDays: 30,
      purchaseEnabled: true,
      subscriptionEnabled: false,
    },
  ],
};

describe("tier purchase links", () => {
  it("keeps the intended checkout tier through login on a path-prefix deployment", () => {
    const html = renderToStaticMarkup(createElement(Tiers, { t, view }));
    expect(html).toContain('href="/base/login?next=%2Fcheckout%2Ftier-1"');
  });

  it("uses the prefixed checkout route for signed-in fans", () => {
    const html = renderToStaticMarkup(
      createElement(Tiers, { t, view: { ...view, isLoggedIn: true } }),
    );
    expect(html).toContain('href="/base/checkout/tier-1"');
  });
});
