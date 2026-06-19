import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

vi.mock("./store", () => ({
  getStoredGroup: vi.fn(),
  setStoredGroup: vi.fn(),
  deleteStoredGroup: vi.fn(),
}));

const mockedGet = vi.mocked(getStoredGroup);
const mockedSet = vi.mocked(setStoredGroup);
const mockedDelete = vi.mocked(deleteStoredGroup);

describe("Stripe configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("is disabled and unconfigured by default", async () => {
    mockedGet.mockResolvedValue(null);
    const { getStripeConfig } = await import("./stripe");
    await expect(getStripeConfig()).resolves.toEqual({
      enabled: false,
      secretKey: undefined,
      webhookSecret: undefined,
      publishableKey: undefined,
      currency: "usd",
      configured: false,
    });
  });

  it("returns secret-set flags without plaintext secrets", async () => {
    mockedGet.mockResolvedValue({
      enabled: true,
      secretKey: "sk_test_secret",
      webhookSecret: "whsec_secret",
      publishableKey: "pk_test_public",
      currency: "usd",
    });
    const { getStripeAdminView } = await import("./stripe");
    const view = await getStripeAdminView();
    expect(view).toMatchObject({
      enabled: true,
      configured: true,
      secretKeySet: true,
      webhookSecretSet: true,
    });
    expect(view).not.toHaveProperty("secretKey");
    expect(view).not.toHaveProperty("webhookSecret");
    expect(JSON.stringify(view)).not.toContain("sk_test_secret");
    expect(JSON.stringify(view)).not.toContain("whsec_secret");
  });

  it("preserves masked secrets and rejects enabling incomplete configuration", async () => {
    mockedGet.mockResolvedValue({
      secretKey: "old-secret",
      webhookSecret: "old-webhook",
    });
    const { saveStripeConfig } = await import("./stripe");
    await saveStripeConfig({
      enabled: true,
      secretKey: " ",
      webhookSecret: "",
      currency: "JPY",
    });
    expect(mockedSet).toHaveBeenCalledWith("stripe", {
      enabled: true,
      secretKey: "old-secret",
      webhookSecret: "old-webhook",
      publishableKey: undefined,
      currency: "jpy",
    });

    mockedGet.mockResolvedValue(null);
    await expect(saveStripeConfig({ enabled: true, currency: "usd" })).rejects.toMatchObject({
      status: 400,
      code: "stripeConfigIncomplete",
    });
  });

  it("clears the encrypted configuration group", async () => {
    const { clearStripeConfig } = await import("./stripe");
    await clearStripeConfig();
    expect(mockedDelete).toHaveBeenCalledWith("stripe");
  });
});
