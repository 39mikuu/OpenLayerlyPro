import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  canAccessPost: vi.fn(),
  getPublishedPostBySlug: vi.fn(),
  getRequiredTier: vi.fn(),
  listPostFiles: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/modules/content", () => ({
  canAccessPost: mocks.canAccessPost,
  getPublishedPostBySlug: mocks.getPublishedPostBySlug,
  getRequiredTier: mocks.getRequiredTier,
  listPostFiles: mocks.listPostFiles,
}));

import { GET } from "./route";

const POST = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Published post",
  slug: "published-post",
  summary: "Summary",
  body: "Body",
  coverFileId: null,
  visibility: "public",
  requiredTierId: null,
  status: "published",
  publishedAt: new Date("2026-06-20T00:00:00.000Z"),
};

function linkedFile(kind: "inline" | "image" | "attachment", suffix: string) {
  return {
    link: { kind },
    file: {
      id: `00000000-0000-4000-8000-0000000000${suffix}`,
      originalName: `${kind}-secret-${suffix}.bin`,
      sizeBytes: Number(suffix),
      mimeType: `application/x-${kind}`,
    },
  };
}

function request() {
  return new NextRequest("http://localhost/api/posts/published-post");
}

describe("public post detail API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getPublishedPostBySlug.mockResolvedValue(POST);
    mocks.getRequiredTier.mockResolvedValue(null);
  });

  it("excludes inline links while preserving public gallery images and attachments", async () => {
    const inline = linkedFile("inline", "11");
    const image = linkedFile("image", "12");
    const attachment = linkedFile("attachment", "13");
    mocks.canAccessPost.mockResolvedValue(true);
    mocks.listPostFiles.mockResolvedValue([inline, image, attachment]);

    const response = await GET(request(), { params: Promise.resolve({ slug: POST.slug }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.files).toEqual([
      {
        id: image.file.id,
        kind: "image",
        originalName: image.file.originalName,
        sizeBytes: image.file.sizeBytes,
        mimeType: image.file.mimeType,
      },
      {
        id: attachment.file.id,
        kind: "attachment",
        originalName: attachment.file.originalName,
        sizeBytes: attachment.file.sizeBytes,
        mimeType: attachment.file.mimeType,
      },
    ]);
    const serialized = JSON.stringify(payload.data.files);
    expect(serialized).not.toContain(inline.file.id);
    expect(serialized).not.toContain(inline.file.originalName);
    expect(serialized).not.toContain(String(inline.file.sizeBytes));
    expect(serialized).not.toContain(inline.file.mimeType);
  });

  it("returns no body or files for a locked post", async () => {
    mocks.canAccessPost.mockResolvedValue(false);

    const response = await GET(request(), { params: Promise.resolve({ slug: POST.slug }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.body).toBeNull();
    expect(payload.data.files).toEqual([]);
    expect(mocks.listPostFiles).not.toHaveBeenCalled();
  });
});
