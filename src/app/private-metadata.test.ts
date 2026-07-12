import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/components/admin/admin-shell", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(() => ({})),
}));

vi.mock("@/modules/admin/navigation", () => ({
  adminNavGroups: [],
}));

vi.mock("@/modules/auth/rate-limit-policy", () => ({
  getLoginCodePolicy: vi.fn(() => ({ length: 6, pattern: /^\d{6}$/ })),
}));

vi.mock("@/modules/auth/session", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/modules/config", () => ({
  getStripeConfig: vi.fn(),
  getTurnstileConfig: vi.fn(),
}));

vi.mock("@/modules/i18n/server", () => ({
  getT: vi.fn(),
}));

vi.mock("@/modules/membership", () => ({
  getActiveMembership: vi.fn(),
  getTierById: vi.fn(),
}));

vi.mock("@/modules/membership/renewal-reminders", () => ({
  getManualReminderTiers: vi.fn(),
}));

vi.mock("@/modules/payment", () => ({
  listPaymentMethods: vi.fn(),
}));

vi.mock("@/modules/payment/subscriptions", () => ({
  getCurrentStripeSubscription: vi.fn(),
}));

vi.mock("@/modules/site", () => ({
  isInitialized: vi.fn(),
}));

vi.mock("@/modules/theme", () => ({
  getActiveTheme: vi.fn(),
}));

import { metadata as checkoutMetadata } from "@/app/(site)/checkout/[tierId]/page";
import { metadata as loginMetadata } from "@/app/(site)/login/page";
import { metadata as meMetadata } from "@/app/(site)/me/page";
import { metadata as adminMetadata } from "@/app/admin/(dashboard)/layout";

describe("private HTML route metadata", () => {
  it("marks login, account, checkout, and admin HTML routes noindex", () => {
    for (const metadata of [loginMetadata, meMetadata, checkoutMetadata, adminMetadata]) {
      expect(metadata.robots).toEqual({ index: false, follow: false });
    }
  });
});
