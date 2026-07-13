import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveTheme: vi.fn(),
  getSupporterWallViewModel: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));
vi.mock("@/modules/i18n/server", () => ({ getT: async () => (key: string) => key }));
vi.mock("@/modules/supporter-wall", () => ({
  getSupporterWallViewModel: mocks.getSupporterWallViewModel,
}));
vi.mock("@/modules/theme", () => ({
  getActiveTheme: mocks.getActiveTheme,
}));

import SupportersPage from "./page";

describe("supporters public page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mocks.getActiveTheme.mockResolvedValue({
      components: {
        SupporterWall: ({ view }: { view: { supporters: { displayName: string }[] } }) =>
          createElement(
            "main",
            null,
            view.supporters.map((supporter) => supporter.displayName).join(","),
          ),
      },
    });
    mocks.getSupporterWallViewModel.mockResolvedValue({
      supporters: [{ displayName: "Fan", tierName: "Gold", dedication: null }],
    });
  });

  it("renders the active theme SupporterWall slot", async () => {
    const html = renderToStaticMarkup(await SupportersPage());

    expect(html).toContain("Fan");
    expect(mocks.getSupporterWallViewModel).toHaveBeenCalledTimes(1);
  });

  it("returns notFound when the view model is null", async () => {
    mocks.getSupporterWallViewModel.mockResolvedValue(null);

    await expect(SupportersPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });
});
