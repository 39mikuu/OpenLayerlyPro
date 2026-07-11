import type { Metadata } from "next";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildPublicPostMetadata: vi.fn(),
}));

vi.mock("@/modules/content/seo", () => ({
  buildPublicPostMetadata: mocks.buildPublicPostMetadata,
}));
vi.mock("@/modules/theme", () => ({
  getActiveTheme: vi.fn(),
}));

import { generateMetadata } from "./page";

function renderOwnedHead(metadata: Metadata): string {
  const title =
    typeof metadata.title === "string"
      ? metadata.title
      : typeof metadata.title === "object" && metadata.title && "absolute" in metadata.title
        ? metadata.title.absolute
        : "";
  const robots =
    typeof metadata.robots === "object" && metadata.robots
      ? `${metadata.robots.index === false ? "noindex" : "index"},${
          metadata.robots.follow === false ? "nofollow" : "follow"
        }`
      : "";
  return JSON.stringify({
    title,
    robots,
    openGraph: metadata.openGraph ?? {},
    twitter: metadata.twitter ?? {},
    alternates: metadata.alternates,
  });
}

describe("post page metadata", () => {
  it("delegates to public-only metadata with promised params", async () => {
    mocks.buildPublicPostMetadata.mockResolvedValue({
      title: "Public Title",
      twitter: { card: "summary", title: "Public Title" },
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "public-title" }),
    });

    expect(mocks.buildPublicPostMetadata).toHaveBeenCalledWith("public-title");
    expect(metadata.title).toBe("Public Title");
  });

  it("renders generic noindex head metadata without post-specific or image fields", async () => {
    mocks.buildPublicPostMetadata.mockResolvedValue({
      title: { absolute: "Public Studio" },
      description: "Generic site description",
      robots: { index: false, follow: false },
      alternates: { canonical: "https://artist.example/posts/member-secret" },
      openGraph: {
        siteName: "Public Studio",
        description: "Generic site description",
        url: "https://artist.example/posts/member-secret",
      },
      twitter: {
        card: "summary",
        title: "Public Studio",
        description: "Generic site description",
      },
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "member-secret" }),
    });
    const head = renderOwnedHead(metadata);

    expect(head).toContain("noindex,nofollow");
    expect(head).toContain('"card":"summary"');
    expect(head).not.toContain("images");
    for (const restricted of [
      "Member Secret Title",
      "Member Secret Summary",
      "cover-secret",
      "Secret Category Name",
      "Secret Tag Name",
      "Secret Tier Name",
    ]) {
      expect(head).not.toContain(restricted);
    }
  });
});
