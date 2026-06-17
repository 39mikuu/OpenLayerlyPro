import { describe, expect, it } from "vitest";

import { en } from "./messages/en";
import { ja } from "./messages/ja";
import { zh } from "./messages/zh";
import { negotiateLocale, translate } from "./translate";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [path] : leafKeys(child, path);
  });
}

describe("translate", () => {
  it("looks up nested keys in the active locale", () => {
    expect(translate("zh", "nav.posts")).toBe("作品");
    expect(translate("en", "nav.posts")).toBe("Works");
    expect(translate("ja", "nav.posts")).toBe("作品");
  });

  it("interpolates params", () => {
    expect(translate("en", "post.memberVisible", { tier: "Gold" })).toBe(
      "Visible to Gold and above",
    );
    expect(translate("zh", "post.memberVisible", { tier: "黄金" })).toBe("黄金及以上可见");
  });

  it("translates stable API errors with structured params", () => {
    expect(translate("en", "errors.cooldownRateLimited", { seconds: 30 })).toBe(
      "Please wait 30 seconds before sending again.",
    );
    expect(
      translate("en", "errors.fileInUse", {
        paymentMethods: 1,
        covers: 2,
        proofs: 3,
        avatar: 4,
      }),
    ).toContain("payment QR codes: 1");
    expect(translate("ja", "errors.cooldownRateLimited", { seconds: 30 })).toBe(
      "30 秒待ってから再送信してください。",
    );
  });

  it("keeps the zh, en and ja dictionary keys identical", () => {
    const expected = leafKeys(zh).sort();
    expect(leafKeys(en).sort()).toEqual(expected);
    expect(leafKeys(ja).sort()).toEqual(expected);
  });

  it("provides Japanese copy for public, admin and setup surfaces", () => {
    const keys = [
      "home.latest",
      "posts.title",
      "post.download",
      "tiers.title",
      "login.heading",
      "me.title",
      "order.title",
      "checkout.submit",
      "admin.nav.settings",
      "admin.posts.editTitle",
      "admin.posts.translations",
      "admin.posts.translationMachineDraft",
      "admin.posts.publishTranslation",
      "admin.common.save",
      "setup.title",
      "setup.submit",
    ];

    for (const key of keys) {
      expect(translate("ja", key)).not.toBe(key);
    }
  });

  it("returns the key when missing in every locale", () => {
    expect(translate("en", "nope.missing")).toBe("nope.missing");
  });

  it("leaves placeholders intact when params are absent", () => {
    expect(translate("en", "post.memberVisible")).toBe("Visible to {tier} and above");
  });
});

describe("negotiateLocale", () => {
  it("matches exact and base subtags, first supported wins", () => {
    expect(negotiateLocale("en-US,en;q=0.9")).toBe("en");
    expect(negotiateLocale("zh-CN,zh;q=0.9")).toBe("zh");
    expect(negotiateLocale("ja-JP,ja;q=0.9")).toBe("ja");
    expect(negotiateLocale("fr,en;q=0.8,zh;q=0.5")).toBe("en");
  });

  it("returns null for unsupported / empty", () => {
    expect(negotiateLocale("fr-FR")).toBeNull();
    expect(negotiateLocale("")).toBeNull();
    expect(negotiateLocale(null)).toBeNull();
  });
});
