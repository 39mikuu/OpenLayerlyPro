import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Post, PostTranslation } from "@/db/schema";
import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  getPostById: vi.fn(),
  upsertDraftTranslation: vi.fn(),
  publishTranslation: vi.fn(),
  getTranslationConfig: vi.fn(),
  getTranslationProvider: vi.fn(),
  translate: vi.fn(),
}));

vi.mock("@/modules/content", () => ({
  getPostById: mocks.getPostById,
  upsertDraftTranslation: mocks.upsertDraftTranslation,
  publishTranslation: mocks.publishTranslation,
}));
vi.mock("@/modules/config", () => ({
  getTranslationConfig: mocks.getTranslationConfig,
}));
vi.mock("./index", () => ({
  getTranslationProvider: mocks.getTranslationProvider,
}));

import {
  generateAiTranslationDraft,
  MAX_TRANSLATION_CHUNK_CHARS,
  splitTranslationText,
} from "./ai-draft";

const sourcePost: Post = {
  id: "post-1",
  title: "原文标题",
  slug: "post",
  summary: "原文摘要",
  body: "第一段\n\n第二段",
  originalLocale: "zh",
  coverFileId: null,
  visibility: "public",
  requiredTierId: null,
  status: "published",
  publishedAt: new Date("2026-01-01T00:00:00Z"),
  scheduledAt: null,
  scheduleToken: null,
  contentUpdatedAt: new Date("2026-02-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
};

const machineDraft: PostTranslation = {
  id: "translation-ja-draft",
  postId: sourcePost.id,
  locale: "ja",
  title: "日本語タイトル",
  summary: "日本語概要",
  body: "第一段の翻訳\n\n第二段の翻訳",
  status: "draft",
  source: "machine",
  sourceUpdatedAt: sourcePost.contentUpdatedAt,
  publishedAt: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPostById.mockResolvedValue(sourcePost);
  mocks.getTranslationConfig.mockResolvedValue({
    directPublishEnabled: false,
  });
  mocks.getTranslationProvider.mockResolvedValue({
    id: "openai-compatible",
    translate: mocks.translate,
  });
  mocks.translate.mockImplementation(async ({ text }: { text: string }) => `JA:${text}`);
  mocks.upsertDraftTranslation.mockResolvedValue(machineDraft);
  mocks.publishTranslation.mockResolvedValue({
    ...machineDraft,
    status: "published",
    publishedAt: new Date("2026-02-02T00:00:00Z"),
  });
});

describe("AI translation drafts", () => {
  it.each([
    ["disabled", new ApiError(400, "translationDisabled")],
    ["missing configuration", new ApiError(400, "translationConfigIncomplete")],
  ])("rejects generation when translation is %s", async (_label, error) => {
    mocks.getTranslationProvider.mockRejectedValue(error);

    await expect(generateAiTranslationDraft(sourcePost.id, "ja")).rejects.toMatchObject({
      status: 400,
      code: error.code,
    });
    expect(mocks.translate).not.toHaveBeenCalled();
    expect(mocks.upsertDraftTranslation).not.toHaveBeenCalled();
  });

  it("generates a Japanese machine draft without publishing", async () => {
    const result = await generateAiTranslationDraft(sourcePost.id, "ja");

    expect(result).toEqual(machineDraft);
    expect(mocks.translate).toHaveBeenCalledTimes(3);
    expect(mocks.translate).toHaveBeenNthCalledWith(1, {
      text: sourcePost.title,
      sourceLocale: "zh",
      targetLocale: "ja",
    });
    expect(mocks.upsertDraftTranslation).toHaveBeenCalledWith(sourcePost.id, "ja", {
      title: "JA:原文标题",
      summary: "JA:原文摘要",
      body: "JA:第一段\n\n第二段",
      source: "machine",
    });
    expect(mocks.publishTranslation).not.toHaveBeenCalled();
  });

  it("chunks a long body and preserves its complete source text", async () => {
    const longBody = `${"甲".repeat(MAX_TRANSLATION_CHUNK_CHARS - 5)}\n\n${"乙".repeat(20)}`;
    mocks.getPostById.mockResolvedValue({ ...sourcePost, summary: null, body: longBody });
    mocks.translate.mockImplementation(async ({ text }: { text: string }) => text);

    await generateAiTranslationDraft(sourcePost.id, "ja");

    const translatedTexts = mocks.translate.mock.calls.map(
      ([request]) => (request as { text: string }).text,
    );
    expect(translatedTexts).toHaveLength(3);
    expect(translatedTexts.slice(1).join("")).toBe(longBody);
    expect(translatedTexts.slice(1).every((text) => text.length <= 6_000)).toBe(true);
    expect(mocks.upsertDraftTranslation).toHaveBeenCalledWith(
      sourcePost.id,
      "ja",
      expect.objectContaining({ body: longBody, source: "machine" }),
    );
  });

  it("rejects unsupported and original locales before calling the provider", async () => {
    await expect(generateAiTranslationDraft(sourcePost.id, "fr")).rejects.toMatchObject({
      code: "unsupportedLocale",
    });
    await expect(generateAiTranslationDraft(sourcePost.id, "zh")).rejects.toMatchObject({
      code: "translationOriginalLocale",
    });
    expect(mocks.getTranslationProvider).not.toHaveBeenCalled();
  });

  it("does not overwrite a published translation", async () => {
    await generateAiTranslationDraft(sourcePost.id, "ja");

    expect(mocks.upsertDraftTranslation).toHaveBeenCalledTimes(1);
    expect(mocks.upsertDraftTranslation).toHaveBeenCalledWith(
      sourcePost.id,
      "ja",
      expect.objectContaining({ source: "machine" }),
    );
  });

  it("rejects a machine draft before saving when the provider mutates a protected token", async () => {
    mocks.getPostById.mockResolvedValue({
      ...sourcePost,
      body: "[link](https://example.com/path) and `code`",
    });
    mocks.translate.mockImplementation(async ({ text }: { text: string }) => {
      if (!text.includes("OLP_MD_")) return `JA:${text}`;
      return text.replace(/OLP_MD_[0-9a-f]{32}_\d{4}_END/, "");
    });

    await expect(generateAiTranslationDraft(sourcePost.id, "ja")).rejects.toMatchObject({
      status: 502,
      code: "translationTokenMismatch",
    });
    expect(mocks.upsertDraftTranslation).not.toHaveBeenCalled();
    expect(mocks.publishTranslation).not.toHaveBeenCalled();
  });

  it("publishes through the content transaction only when explicitly enabled", async () => {
    mocks.getTranslationConfig.mockResolvedValue({
      directPublishEnabled: true,
    });

    const result = await generateAiTranslationDraft(sourcePost.id, "ja");

    expect(mocks.upsertDraftTranslation).toHaveBeenCalledTimes(1);
    expect(mocks.publishTranslation).toHaveBeenCalledWith(sourcePost.id, "ja");
    expect(result).toMatchObject({ status: "published", source: "machine" });
  });
});

describe("splitTranslationText", () => {
  it("prefers paragraph boundaries and keeps every character", () => {
    const text = "1234\n\n5678\n90";
    const chunks = splitTranslationText(text, 7);

    expect(chunks).toEqual(["1234\n\n", "5678\n90"]);
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits content without a nearby line boundary", () => {
    expect(splitTranslationText("123456789", 4)).toEqual(["1234", "5678", "9"]);
  });

  it("does not include a separator that starts at the maxChars boundary", () => {
    const text = "1234\n\n5678";
    const chunks = splitTranslationText(text, 4);

    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
    expect(chunks[0]).toBe("1234");
  });

  it("never exceeds maxChars even when the limit is shorter than a separator", () => {
    const chunks = splitTranslationText("\n\nabc", 1);

    expect(chunks.join("")).toBe("\n\nabc");
    expect(chunks.every((chunk) => chunk.length <= 1)).toBe(true);
  });
});
