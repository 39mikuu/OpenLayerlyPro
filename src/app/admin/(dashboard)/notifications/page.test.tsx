import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listNotificationCampaignAdminSummaries: vi.fn(),
}));

vi.mock("@/modules/i18n/server", async () => {
  const { translate } = await vi.importActual<typeof import("@/modules/i18n/translate")>(
    "@/modules/i18n/translate",
  );
  return {
    getT: async () => (key: string, params?: Record<string, string | number>) =>
      translate("zh", key, params),
  };
});
vi.mock("@/modules/notifications/admin", () => ({
  listNotificationCampaignAdminSummaries: mocks.listNotificationCampaignAdminSummaries,
}));

import AdminNotificationsPage from "./page";

describe("admin notification campaigns page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listNotificationCampaignAdminSummaries.mockResolvedValue([
      {
        id: "11111111-2222-3333-4444-555555555555",
        postId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        postTitle: "A very long notification campaign post title that must wrap on mobile",
        postSlug: "a-very-long-notification-campaign-post-slug-that-must-wrap-on-mobile",
        source: "scheduled_publish",
        status: "dead",
        publishedAt: new Date("2026-08-20T00:00:00.000Z"),
        cursorUserId: "99999999-8888-7777-6666-555555555555",
        expansionCompletedAt: new Date("2026-08-20T00:10:00.000Z"),
        completedAt: null,
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: new Date("2026-08-20T00:20:00.000Z"),
        lastError: "smtp-provider-error-with-a-very-long-unbroken-value<script>alert(1)</script>",
        deliveryCounts: { accepted: 3, dead: 1 },
        attemptCounts: { permanent_failure: 2, lease_expired: 1 },
        suppressionCount: 4,
      },
    ]);
  });

  it("renders a desktop table and mobile card with localized grouped counts", async () => {
    const html = renderToStaticMarkup(await AdminNotificationsPage());

    expect(html).toContain('data-slot="table-container"');
    expect(html).toContain('data-slot="admin-mobile-data-card"');
    expect(html).toContain("已终止");
    expect(html).toContain("定时发布");
    expect(html).toContain("已接受");
    expect(html).toContain("永久失败");
    expect(html).toContain("租约已过期");
    expect(html).toContain("抑制名单");
    expect(html).not.toContain("accepted:3");
    expect(html).not.toContain("permanent_failure:2");
    expect(html).not.toContain("suppressions:4");
    expect(html).not.toContain("scheduled_publish");
  });

  it("keeps long diagnostics available in native collapsible controls", async () => {
    const html = renderToStaticMarkup(await AdminNotificationsPage());

    expect(html.match(/<details/g)).toHaveLength(4);
    expect(html).toContain("技术详情");
    expect(html).toContain("查看错误详情");
    expect(html).toContain("11111111-2222-3333-4444-555555555555");
    expect(html).toContain("99999999-8888-7777-6666-555555555555");
    expect(html).toContain(
      "smtp-provider-error-with-a-very-long-unbroken-value&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(html).not.toContain("<script>");
  });
});
