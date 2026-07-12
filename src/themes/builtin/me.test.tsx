import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Translate } from "@/modules/i18n";
import type { MeView } from "@/modules/theme/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { Me } from "./me";

const t: Translate = (key) => key;

function view(overrides: Partial<MeView> = {}): MeView {
  return {
    email: "fan@example.test",
    isAdmin: false,
    notificationPreferences: { newPostEmailEnabled: false, version: 0 },
    membership: null,
    subscription: null,
    ...overrides,
  };
}

describe("builtin Me notification preferences", () => {
  it("renders the default-off new post email toggle", () => {
    const html = renderToStaticMarkup(createElement(Me, { t, view: view() }));

    expect(html).toContain("me.newPostEmailTitle");
    expect(html).toContain("开启新内容邮件");
    expect(html).toContain("me.newPostEmailOff");
  });

  it("renders the enabled state", () => {
    const html = renderToStaticMarkup(
      createElement(Me, {
        t,
        view: view({ notificationPreferences: { newPostEmailEnabled: true, version: 2 } }),
      }),
    );

    expect(html).toContain("关闭新内容邮件");
    expect(html).toContain("me.newPostEmailOn");
  });
});
