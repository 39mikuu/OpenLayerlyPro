import { describe, expect, it } from "vitest";

import { DEFAULT_MEMBERSHIP_TIERS } from "./default-tiers";

describe("default membership tiers", () => {
  it("provides purchasable CNY amounts that match every displayed price", () => {
    expect(
      DEFAULT_MEMBERSHIP_TIERS.map(({ slug, priceLabel, priceAmountMinor, currency }) => ({
        slug,
        priceLabel,
        priceAmountMinor,
        currency,
      })),
    ).toEqual([
      { slug: "supporter", priceLabel: "¥9 / 月", priceAmountMinor: 900, currency: "cny" },
      { slug: "hd-member", priceLabel: "¥29 / 月", priceAmountMinor: 2900, currency: "cny" },
      { slug: "pack-member", priceLabel: "¥59 / 月", priceAmountMinor: 5900, currency: "cny" },
    ]);
  });

  it("gives every preset distinct non-empty product copy", () => {
    const descriptions = DEFAULT_MEMBERSHIP_TIERS.map(({ description }) => description.trim());

    expect(descriptions.every(Boolean)).toBe(true);
    expect(new Set(descriptions).size).toBe(DEFAULT_MEMBERSHIP_TIERS.length);
  });
});
