import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n-provider";
import type { Translate } from "@/modules/i18n";
import { zh } from "@/modules/i18n/messages/zh";
import type { MeView } from "@/modules/theme/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { Me } from "./me";

const t: Translate = (key) => key;

function renderMe(viewValue: MeView): string {
  return renderToStaticMarkup(
    <I18nProvider locale="zh" messages={zh}>
      <Me t={t} view={viewValue} />
    </I18nProvider>,
  );
}

function view(overrides: Partial<MeView> = {}): MeView {
  return {
    email: "fan@example.test",
    displayName: "Fan Name",
    isAdmin: false,
    supporterWall: {
      settings: { enabled: true, minLevel: null },
      entry: null,
    },
    notificationPreferences: { newPostEmailEnabled: false, version: 0 },
    membership: null,
    subscription: null,
    ...overrides,
  };
}

describe("builtin Me notification preferences", () => {
  it("renders the default-off new post email toggle", () => {
    const html = renderMe(view());

    expect(html).toContain("me.newPostEmailTitle");
    expect(html).toContain("开启新内容邮件");
    expect(html).toContain("me.newPostEmailOff");
  });

  it("renders the enabled state", () => {
    const html = renderMe(
      view({ notificationPreferences: { newPostEmailEnabled: true, version: 2 } }),
    );

    expect(html).toContain("关闭新内容邮件");
    expect(html).toContain("me.newPostEmailOn");
  });
});
