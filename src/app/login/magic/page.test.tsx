import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appUrl: "https://artist.example/base",
  verifyMagicLinkToken: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ APP_URL: mocks.appUrl }),
}));
vi.mock("@/modules/i18n/server", () => ({
  getT: async () => (key: string) => key,
}));
vi.mock("@/modules/auth/magic-link", () => ({
  verifyMagicLinkToken: mocks.verifyMagicLinkToken,
}));

import MagicLinkConfirmPage from "./[token]/page";
import MagicLinkResultPage from "./result/page";

const TOKEN = "olp_mlk.v1.current.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("magic link confirm and result pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appUrl = "https://artist.example/base";
    mocks.verifyMagicLinkToken.mockResolvedValue({ status: "valid", tokenId: "token-1" });
  });

  it("renders a confirm form posting to the /base-prefixed API without consuming the token", async () => {
    const html = renderToStaticMarkup(
      createElement(
        await MagicLinkConfirmPage({ params: Promise.resolve({ token: TOKEN }) }).then(
          (node) => () => node,
        ),
      ),
    );

    expect(mocks.verifyMagicLinkToken).toHaveBeenCalledWith(TOKEN);
    expect(html).toContain('action="https://artist.example/base/api/auth/magic-link/confirm"');
    expect(html).toContain('method="post"');
    expect(html).toContain("magicLink.confirmAction");
  });

  it("decodes an URL-encoded token segment before verifying", async () => {
    await MagicLinkConfirmPage({
      params: Promise.resolve({ token: encodeURIComponent(TOKEN) }),
    });
    expect(mocks.verifyMagicLinkToken).toHaveBeenCalledWith(TOKEN);
  });

  it.each(["expired", "replayed", "invalid"] as const)(
    "shows the %s state without a confirm form",
    async (status) => {
      mocks.verifyMagicLinkToken.mockResolvedValue({ status });

      const html = renderToStaticMarkup(
        createElement(
          await MagicLinkConfirmPage({ params: Promise.resolve({ token: TOKEN }) }).then(
            (node) => () => node,
          ),
        ),
      );

      expect(html).toContain(`magicLink.resultTitle${status}`);
      expect(html).not.toContain("method=");
      expect(html).toContain('href="https://artist.example/base/login"');
    },
  );

  it("result page reads the status and keeps the /base prefix on the login link", async () => {
    const html = renderToStaticMarkup(
      createElement(
        await MagicLinkResultPage({
          searchParams: Promise.resolve({ status: "replayed" }),
        }).then((node) => () => node),
      ),
    );

    expect(html).toContain("magicLink.resultTitlereplayed");
    expect(html).toContain('href="https://artist.example/base/login"');
  });

  it("result page collapses unknown statuses to invalid", async () => {
    const html = renderToStaticMarkup(
      createElement(
        await MagicLinkResultPage({
          searchParams: Promise.resolve({ status: "weird" }),
        }).then((node) => () => node),
      ),
    );

    expect(html).toContain("magicLink.resultTitleinvalid");
  });

  it("keeps a validated checkout target when an email link has expired", async () => {
    mocks.verifyMagicLinkToken.mockResolvedValue({
      status: "expired",
      redirectPath: "/checkout/tier-1",
    });
    const confirmHtml = renderToStaticMarkup(
      createElement(
        await MagicLinkConfirmPage({ params: Promise.resolve({ token: TOKEN }) }).then(
          (node) => () => node,
        ),
      ),
    );
    expect(confirmHtml).toContain("/login?next=%2Fcheckout%2Ftier-1");

    const resultHtml = renderToStaticMarkup(
      createElement(
        await MagicLinkResultPage({
          searchParams: Promise.resolve({ status: "expired", next: "/checkout/tier-1" }),
        }).then((node) => () => node),
      ),
    );
    expect(resultHtml).toContain("/login?next=%2Fcheckout%2Ftier-1");
  });

  it("keeps the checkout target when a matching link is no longer active", async () => {
    mocks.verifyMagicLinkToken.mockResolvedValue({
      status: "invalid",
      redirectPath: "/checkout/tier-1",
    });
    const html = renderToStaticMarkup(
      createElement(
        await MagicLinkConfirmPage({ params: Promise.resolve({ token: TOKEN }) }).then(
          (node) => () => node,
        ),
      ),
    );
    expect(html).toContain('href="https://artist.example/base/login?next=%2Fcheckout%2Ftier-1"');
    expect(html).not.toContain("method=");
  });

  it("rejects an external retry target", async () => {
    const html = renderToStaticMarkup(
      createElement(
        await MagicLinkResultPage({
          searchParams: Promise.resolve({ status: "expired", next: "https://evil.example" }),
        }).then((node) => () => node),
      ),
    );
    expect(html).toContain('href="https://artist.example/base/login"');
  });
});
