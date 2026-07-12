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

import { renderNextMetadataTags } from "@/modules/content/metadata-tags.test-helper";

import { generateMetadata } from "./page";

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
        title: "Public Studio",
        type: "website",
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
    const head = await renderNextMetadataTags(metadata);

    expect(head).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(head).toContain('<meta property="og:title" content="Public Studio"/>');
    expect(head).toContain('<meta property="og:type" content="website"/>');
    expect(head).toContain(
      '<meta property="og:url" content="https://artist.example/posts/member-secret"/>',
    );
    expect(head).toContain(
      '<link rel="canonical" href="https://artist.example/posts/member-secret"/>',
    );
    expect(head).toContain('<meta name="twitter:card" content="summary"/>');
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
