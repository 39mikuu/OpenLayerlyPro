import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/modules/i18n/messages/en";
import { ja } from "@/modules/i18n/messages/ja";
import { zh } from "@/modules/i18n/messages/zh";

const mocks = vi.hoisted(() => ({
  listMembershipsPage: vi.fn(),
  listTiers: vi.fn(),
  listPaymentRequestsPage: vi.fn(),
  listFilesPage: vi.fn(),
  listQuarantinedFilesPage: vi.fn(),
}));

vi.mock("@/modules/membership", () => ({
  listMembershipsPage: mocks.listMembershipsPage,
  listTiers: mocks.listTiers,
}));
vi.mock("@/modules/payment", () => ({
  listPaymentRequestsPage: mocks.listPaymentRequestsPage,
}));
vi.mock("@/modules/file", () => ({
  listFilesPage: mocks.listFilesPage,
  listQuarantinedFilesPage: mocks.listQuarantinedFilesPage,
}));
vi.mock("@/modules/i18n/server", () => ({
  getT: async () => (key: string) => {
    if (key === "admin.common.firstPage") return "First page";
    if (key === "admin.reviews.pending") return "Pending reviews";
    return key;
  },
}));
vi.mock("@/components/admin/membership-grant-form", () => ({
  MembershipGrantForm: () => null,
}));

import AdminFilesPage, { filesPageHref } from "./(dashboard)/files/page";
import AdminMembershipsPage from "./(dashboard)/memberships/page";
import AdminPaymentReviewsPage, { paymentPageHref } from "./(dashboard)/payments/reviews/page";

const emptyPage = { items: [], nextCursor: null };

describe("admin pagination pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMembershipsPage.mockResolvedValue(emptyPage);
    mocks.listTiers.mockResolvedValue([]);
    mocks.listPaymentRequestsPage.mockResolvedValue(emptyPage);
    mocks.listFilesPage.mockResolvedValue(emptyPage);
    mocks.listQuarantinedFilesPage.mockResolvedValue(emptyPage);
  });

  it("does not describe the current pending page size as a total", () => {
    expect(en.admin.reviews.pending).toBe("Pending reviews");
    expect(zh.admin.reviews.pending).toBe("待审核");
    expect(ja.admin.reviews.pending).toBe("確認待ち");
    expect(en.admin.reviews.pending).not.toContain("{count}");
  });

  it("shows a memberships first-page link only when a cursor is present", async () => {
    const withCursor = renderToStaticMarkup(
      await AdminMembershipsPage({ searchParams: Promise.resolve({ cursor: "current" }) }),
    );
    const withoutCursor = renderToStaticMarkup(
      await AdminMembershipsPage({ searchParams: Promise.resolve({}) }),
    );

    expect(withCursor).toContain('href="/admin/memberships"');
    expect(withCursor).toContain("First page");
    expect(withoutCursor).not.toContain("First page");
  });

  it("clears only one payment cursor and URL-encodes the preserved cursor", async () => {
    expect(
      paymentPageHref(
        { pendingCursor: "pending value&", historyCursor: "history value/?" },
        "pendingCursor",
      ),
    ).toBe("/admin/payments/reviews?historyCursor=history+value%2F%3F");
    expect(
      paymentPageHref(
        { pendingCursor: "pending value&", historyCursor: "history value/?" },
        "historyCursor",
      ),
    ).toBe("/admin/payments/reviews?pendingCursor=pending+value%26");

    const html = renderToStaticMarkup(
      await AdminPaymentReviewsPage({
        searchParams: Promise.resolve({
          pendingCursor: "pending value&",
          historyCursor: "history value/?",
        }),
      }),
    );
    expect(html.match(/First page/g)).toHaveLength(2);
    const firstPage = renderToStaticMarkup(
      await AdminPaymentReviewsPage({ searchParams: Promise.resolve({}) }),
    );
    expect(firstPage).not.toContain("First page");
  });

  it("clears only one file cursor and URL-encodes the preserved cursor", async () => {
    expect(
      filesPageHref({ cursor: "active value&", quarantinedCursor: "quarantine value/?" }, "cursor"),
    ).toBe("/admin/files?quarantinedCursor=quarantine+value%2F%3F");
    expect(
      filesPageHref(
        { cursor: "active value&", quarantinedCursor: "quarantine value/?" },
        "quarantinedCursor",
      ),
    ).toBe("/admin/files?cursor=active+value%26");

    const html = renderToStaticMarkup(
      await AdminFilesPage({
        searchParams: Promise.resolve({
          cursor: "active value&",
          quarantinedCursor: "quarantine value/?",
        }),
      }),
    );
    expect(html.match(/First page/g)).toHaveLength(2);
    const firstPage = renderToStaticMarkup(
      await AdminFilesPage({ searchParams: Promise.resolve({}) }),
    );
    expect(firstPage).not.toContain("First page");
  });
});
