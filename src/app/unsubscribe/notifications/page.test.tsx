import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appUrl: "https://artist.example/base",
  verifyNotificationUnsubscribeToken: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ APP_URL: mocks.appUrl }),
}));
vi.mock("@/modules/i18n/server", () => ({
  getT: async () => (key: string) => key,
}));
vi.mock("@/modules/notifications", () => ({
  verifyNotificationUnsubscribeToken: mocks.verifyNotificationUnsubscribeToken,
}));

import NotificationUnsubscribePage from "./[token]/page";
import NotificationUnsubscribeResultPage from "./result/page";

describe("notification unsubscribe pages under an APP_URL path prefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appUrl = "https://artist.example/base";
    mocks.verifyNotificationUnsubscribeToken.mockResolvedValue({ valid: true });
  });

  it("confirm form posts to the /base-prefixed API route", async () => {
    const html = renderToStaticMarkup(
      createElement(
        await NotificationUnsubscribePage({ params: Promise.resolve({ token: "tok" }) }).then(
          (node) => () => node,
        ),
      ),
    );

    expect(html).toContain('action="https://artist.example/base/api/notifications/unsubscribe"');
  });

  it("invalid-token home link keeps the /base prefix", async () => {
    mocks.verifyNotificationUnsubscribeToken.mockResolvedValue({
      valid: false,
      reason: "bad-mac",
    });

    const html = renderToStaticMarkup(
      createElement(
        await NotificationUnsubscribePage({ params: Promise.resolve({ token: "tok" }) }).then(
          (node) => () => node,
        ),
      ),
    );

    expect(html).toContain('href="https://artist.example/base/"');
  });

  it("result page home link keeps the /base prefix and reads the status", async () => {
    const html = renderToStaticMarkup(
      createElement(
        await NotificationUnsubscribeResultPage({
          searchParams: Promise.resolve({ status: "success" }),
        }).then((node) => () => node),
      ),
    );

    expect(html).toContain('href="https://artist.example/base/"');
    expect(html).toContain("resultTitlesuccess");
  });

  it("stays correct without a path prefix", async () => {
    mocks.appUrl = "https://artist.example";

    const html = renderToStaticMarkup(
      createElement(
        await NotificationUnsubscribePage({ params: Promise.resolve({ token: "tok" }) }).then(
          (node) => () => node,
        ),
      ),
    );

    expect(html).toContain('action="https://artist.example/api/notifications/unsubscribe"');
  });
});
