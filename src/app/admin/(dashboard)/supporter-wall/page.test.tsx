import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSupporterWallSettings: vi.fn(),
  listSupporterWallEntriesPage: vi.fn(),
}));

vi.mock("@/components/admin/supporter-wall-moderation-actions", () => ({
  SupporterWallModerationActions: ({ entryId }: { entryId: string }) => <span>{entryId}</span>,
}));
vi.mock("@/components/admin/supporter-wall-settings-form", () => ({
  SupporterWallSettingsForm: () => <form>settings-form</form>,
}));
vi.mock("@/modules/i18n/server", () => ({ getT: async () => (key: string) => key }));
vi.mock("@/modules/supporter-wall", () => ({
  getSupporterWallSettings: mocks.getSupporterWallSettings,
  listSupporterWallEntriesPage: mocks.listSupporterWallEntriesPage,
}));

import AdminSupporterWallPage from "./page";

describe("admin supporter wall page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSupporterWallSettings.mockResolvedValue({ enabled: true, minLevel: null });
    mocks.listSupporterWallEntriesPage.mockResolvedValue({
      items: [
        {
          id: "entry-1",
          displayName: "Fan",
          activeTierName: "Gold",
          dedication: "<script>alert(1)</script>",
          status: "pending",
          version: 0,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      nextCursor: "cursor-1",
    });
  });

  it("renders settings and escaped dedication text", async () => {
    const html = renderToStaticMarkup(
      await AdminSupporterWallPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain("settings-form");
    expect(html).toContain("Fan");
    expect(html).toContain("Gold");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});
