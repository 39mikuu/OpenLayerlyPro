import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/i18n-provider", () => ({ useT: () => (key: string) => key }));

import { CheckoutForm } from "./checkout-form";

const methods = [
  { id: "method-a", name: "Alipay", description: "Scan to pay", qrFileId: null },
  { id: "method-b", name: "WeChat", description: null, qrFileId: null },
];

describe("checkout form semantics", () => {
  it("groups payment methods in a fieldset with native radios", () => {
    const html = renderToStaticMarkup(createElement(CheckoutForm, { tierId: "tier-1", methods }));
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).toContain('type="radio"');
    expect(html).toContain('name="payment-method"');
    expect(html).toContain("Alipay");
    expect(html).toContain("WeChat");
  });

  it("exposes a focus-visible ring on the proof dropzone peer label", () => {
    const html = renderToStaticMarkup(createElement(CheckoutForm, { tierId: "tier-1", methods }));
    expect(html).toContain("peer-focus-visible:ring-");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("renders an empty-methods notice without a fieldset when none configured", () => {
    const html = renderToStaticMarkup(
      createElement(CheckoutForm, { tierId: "tier-1", methods: [] }),
    );
    expect(html).toContain("checkout.noMethodsTitle");
    expect(html).not.toContain("<fieldset");
  });
});
