import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Translate } from "@/modules/i18n";
import type { PostDetailView } from "@/modules/theme/types";

import { PostDetail } from "./post-detail";

const t: Translate = (key) => key;

function view(overrides: Partial<PostDetailView> = {}): PostDetailView {
  return {
    title: "Post",
    publishedAt: new Date("2026-06-20T00:00:00.000Z"),
    visibility: "public",
    requiredTierName: null,
    summary: null,
    coverUrl: null,
    isLoggedIn: false,
    allowed: true,
    body: null,
    bodyHtml: null,
    images: [],
    attachments: [],
    machineTranslated: false,
    categories: [],
    tags: [],
    ...overrides,
  };
}

function render(viewValue: PostDetailView): string {
  return renderToStaticMarkup(createElement(PostDetail, { t, view: viewValue }));
}

describe("builtin post detail video attachments", () => {
  it("renders a native inline player and always keeps the download action", () => {
    const html = render(
      view({
        attachments: [
          {
            downloadHref: "/download/video-id",
            playHref: "/api/files/video-id/download?mode=inline",
            name: "video.mp4",
            sizeBytes: 1024,
            mimeType: "video/mp4",
            inlineCandidate: true,
          },
        ],
      }),
    );

    expect(html).toContain("<video");
    expect(html).toContain('controls=""');
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('playsInline=""');
    expect(html).toContain('src="/api/files/video-id/download?mode=inline"');
    expect(html).toContain('aria-label="post.playVideo"');
    expect(html).toContain("post.videoUnsupported");
    expect(html).toContain('href="/download/video-id"');
    expect(html).toContain("post.downloadVideo");
  });

  it("does not render a player for a non-video attachment", () => {
    const html = render(
      view({
        attachments: [
          {
            downloadHref: "/download/archive-id",
            name: "archive.zip",
            sizeBytes: 2048,
            mimeType: "application/zip",
            inlineCandidate: false,
          },
        ],
      }),
    );

    expect(html).not.toContain("<video");
    expect(html).toContain('href="/download/archive-id"');
    expect(html).toContain("post.download");
  });

  it("does not expose players or attachments on a locked page", () => {
    const html = render(
      view({
        allowed: false,
        visibility: "member",
        requiredTierName: "Gold",
        attachments: [
          {
            downloadHref: "/download/private-video",
            playHref: "/api/files/private-video/download?mode=inline",
            name: "private.mp4",
            sizeBytes: 4096,
            mimeType: "video/mp4",
            inlineCandidate: true,
          },
        ],
      }),
    );

    expect(html).not.toContain("<video");
    expect(html).not.toContain("/download/private-video");
    expect(html).toContain("post.lockedTitle");
  });
});
