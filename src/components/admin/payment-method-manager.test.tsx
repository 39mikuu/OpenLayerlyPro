import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n-provider";
import { en } from "@/modules/i18n/messages/en";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { PaymentMethodManager } from "./payment-method-manager";

function renderManager(methods: Parameters<typeof PaymentMethodManager>[0]["methods"]) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={en}>
      <PaymentMethodManager methods={methods} />
    </I18nProvider>,
  );
}

describe("PaymentMethodManager", () => {
  it("shows a useful first-run empty state with a creation action", () => {
    const html = renderManager([]);

    expect(html).toContain("No payment methods yet");
    expect(html).toContain("Once enabled, fans can select it at checkout");
    expect(html).toContain("New payment method");
    expect(html).toContain("border-dashed");
  });

  it("keeps the compact creation action once methods exist", () => {
    const html = renderManager([
      {
        id: "method-1",
        name: "Bank transfer",
        description: "Use the reference shown at checkout",
        qrFileId: null,
        isActive: true,
        sortOrder: 0,
      },
    ]);

    expect(html).toContain("Bank transfer");
    expect(html).toContain("New payment method");
    expect(html).not.toContain("No payment methods yet");
  });
});
