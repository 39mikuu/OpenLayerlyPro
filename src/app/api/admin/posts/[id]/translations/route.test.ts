import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { MAX_POST_BODY_LENGTH, POST_JSON_MAX_BYTES } from "@/modules/content/markdown";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getPostById: vi.fn(),
  listPostTranslations: vi.fn(),
  upsertDraftTranslation: vi.fn(),
  publishTranslation: vi.fn(),
  unpublishTranslation: vi.fn(),
  deleteDraftTranslation: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/content", () => ({
  getPostById: mocks.getPostById,
  listPostTranslations: mocks.listPostTranslations,
  upsertDraftTranslation: mocks.upsertDraftTranslation,
  publishTranslation: mocks.publishTranslation,
  unpublishTranslation: mocks.unpublishTranslation,
  deleteDraftTranslation: mocks.deleteDraftTranslation,
}));

import { POST as publish } from "./[locale]/publish/route";
import { DELETE } from "./[locale]/route";
import { POST as unpublish } from "./[locale]/unpublish/route";
import { GET, PUT } from "./route";

const sourcePost = {
  id: "post-1",
  title: "原文标题",
  slug: "post",
  summary: "原文摘要",
  body: "原文正文",
  originalLocale: "zh",
  coverFileId: null,
  visibility: "public",
  requiredTierId: null,
  status: "published",
  publishedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
} as const;

const japaneseDraft = {
  id: "translation-ja",
  postId: "post-1",
  locale: "ja",
  title: "日本語タイトル",
  summary: "日本語概要",
  body: "日本語本文",
  status: "draft",
  source: "manual",
  sourceUpdatedAt: sourcePost.updatedAt,
  publishedAt: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
} as const;

function request(method: string, body?: unknown): NextRequest {
  return new Request("http://localhost/api/admin/posts/post-1/translations", {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function postContext() {
  return { params: Promise.resolve({ id: "post-1" }) };
}

function localeContext(locale = "ja") {
  return { params: Promise.resolve({ id: "post-1", locale }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
  mocks.getPostById.mockResolvedValue(sourcePost);
  mocks.listPostTranslations.mockResolvedValue([japaneseDraft]);
  mocks.upsertDraftTranslation.mockImplementation(
    async (_postId: string, locale: string, input: { title: string }) => ({
      ...japaneseDraft,
      locale,
      title: input.title,
    }),
  );
  mocks.publishTranslation.mockResolvedValue({
    ...japaneseDraft,
    status: "published",
    publishedAt: new Date("2026-02-02T00:00:00Z"),
  });
  mocks.unpublishTranslation.mockResolvedValue(undefined);
  mocks.deleteDraftTranslation.mockResolvedValue(undefined);
});

describe("admin post translation APIs", () => {
  it.each([
    [401, "authRequired"],
    [403, "adminRequired"],
  ])("rejects unauthorized access with %s", async (status, code) => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(status, code));

    const response = await GET(request("GET"), postContext());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code });
    expect(mocks.getPostById).not.toHaveBeenCalled();
  });

  it("requires admin access for every mutation endpoint", async () => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(403, "adminRequired"));

    const responses = await Promise.all([
      PUT(request("PUT", { locale: "ja", title: "日本語タイトル" }), postContext()),
      publish(request("POST"), localeContext()),
      unpublish(request("POST"), localeContext()),
      DELETE(request("DELETE"), localeContext()),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(mocks.upsertDraftTranslation).not.toHaveBeenCalled();
    expect(mocks.publishTranslation).not.toHaveBeenCalled();
    expect(mocks.unpublishTranslation).not.toHaveBeenCalled();
    expect(mocks.deleteDraftTranslation).not.toHaveBeenCalled();
  });

  it("returns the translation overview", async () => {
    const response = await GET(request("GET"), postContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        post: {
          id: "post-1",
          originalLocale: "zh",
          title: "原文标题",
        },
        availableLocales: ["en", "ja"],
        translations: [{ id: "translation-ja", locale: "ja", status: "draft" }],
      },
    });
  });

  it.each(["en", "ja"])("saves a manual %s draft", async (locale) => {
    const response = await PUT(
      request("PUT", {
        locale,
        title: locale === "ja" ? "日本語タイトル" : "English title",
        summary: null,
        body: "Body",
      }),
      postContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsertDraftTranslation).toHaveBeenCalledWith("post-1", locale, {
      title: locale === "ja" ? "日本語タイトル" : "English title",
      summary: null,
      body: "Body",
      source: "manual",
    });
  });

  it("accepts a 90,000 character ASCII body before business validation", async () => {
    const body = "x".repeat(90_000);
    const response = await PUT(
      request("PUT", {
        locale: "ja",
        title: "日本語タイトル",
        body,
      }),
      postContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsertDraftTranslation).toHaveBeenCalledWith(
      "post-1",
      "ja",
      expect.objectContaining({ body }),
    );
  });

  it("accepts a near-limit multi-byte CJK body before business validation", async () => {
    const body = "界".repeat(MAX_POST_BODY_LENGTH - 1);
    const response = await PUT(
      request("PUT", {
        locale: "ja",
        title: "日本語タイトル",
        body,
      }),
      postContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsertDraftTranslation).toHaveBeenCalledWith(
      "post-1",
      "ja",
      expect.objectContaining({ body }),
    );
  });

  it("keeps the schema character limit at 100,000 characters", async () => {
    const response = await PUT(
      request("PUT", {
        locale: "ja",
        title: "日本語タイトル",
        body: "x".repeat(MAX_POST_BODY_LENGTH + 1),
      }),
      postContext(),
    );

    expect(response.status).toBe(400);
    expect(mocks.upsertDraftTranslation).not.toHaveBeenCalled();
  });

  it("rejects JSON transfers above the post-specific byte limit", async () => {
    const response = await PUT(
      request("PUT", {
        locale: "ja",
        title: "日本語タイトル",
        body: "x".repeat(POST_JSON_MAX_BYTES),
      }),
      postContext(),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "requestBodyTooLarge" });
    expect(mocks.upsertDraftTranslation).not.toHaveBeenCalled();
  });

  it("preserves the machine source when an admin edits a review draft", async () => {
    const response = await PUT(
      request("PUT", {
        locale: "ja",
        title: "校正済みタイトル",
        summary: null,
        body: "校正済み本文",
        source: "machine",
      }),
      postContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsertDraftTranslation).toHaveBeenCalledWith("post-1", "ja", {
      title: "校正済みタイトル",
      summary: null,
      body: "校正済み本文",
      source: "machine",
    });
  });

  it.each([
    ["empty title", new ApiError(400, "translationTitleRequired")],
    ["original locale", new ApiError(400, "translationOriginalLocale", { locale: "zh" })],
  ])("returns a stable error for %s", async (_label, error) => {
    mocks.upsertDraftTranslation.mockRejectedValue(error);

    const response = await PUT(
      request("PUT", { locale: "zh", title: "", summary: null, body: null }),
      postContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: error.code });
  });

  it("publishes a Japanese draft", async () => {
    const response = await publish(request("POST"), localeContext());

    expect(response.status).toBe(200);
    expect(mocks.publishTranslation).toHaveBeenCalledWith("post-1", "ja");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { locale: "ja", status: "published" },
    });
  });

  it("unpublishes a Japanese translation", async () => {
    const response = await unpublish(request("POST"), localeContext());

    expect(response.status).toBe(200);
    expect(mocks.unpublishTranslation).toHaveBeenCalledWith("post-1", "ja");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { unpublished: true },
    });
  });

  it("deletes a Japanese draft", async () => {
    const response = await DELETE(request("DELETE"), localeContext());

    expect(response.status).toBe(200);
    expect(mocks.deleteDraftTranslation).toHaveBeenCalledWith("post-1", "ja");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { deleted: true },
    });
  });

  it("does not leak database error details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.publishTranslation.mockRejectedValue(
      new Error('duplicate key violates "post_translations_one_published_per_locale"'),
    );

    const response = await publish(request("POST"), localeContext());
    const body = (await response.json()) as { code: string; error: string };

    expect(response.status).toBe(500);
    expect(body.code).toBe("internalError");
    expect(body.error).not.toContain("duplicate key");
    log.mockRestore();
  });
});
