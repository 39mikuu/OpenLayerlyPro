import { describe, expect, it } from "vitest";

import {
  editableTranslation,
  hasPublishableTitle,
  translationEditorStatus,
  translationLocales,
  type TranslationVersion,
  translationVersionsForLocale,
} from "./post-translation-editor-model";

function version(overrides: Partial<TranslationVersion> = {}): TranslationVersion {
  return {
    id: "translation-1",
    locale: "ja",
    title: "日本語タイトル",
    summary: "日本語概要",
    body: "日本語本文",
    status: "draft",
    source: "manual",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("post translation editor model", () => {
  it("offers English and Japanese when Chinese is the original locale", () => {
    expect(translationLocales(["zh", "en", "ja"], "zh")).toEqual(["en", "ja"]);
  });

  it.each([
    [[], "untranslated"],
    [[version()], "draft"],
    [[version({ status: "published" })], "published"],
    [[version({ source: "machine" })], "machineDraft"],
  ] as const)("derives translation status", (translations, expected) => {
    const versions = translationVersionsForLocale([...translations], "ja");
    expect(translationEditorStatus(versions)).toBe(expected);
  });

  it("prefers a Japanese draft over the published version for editing", () => {
    const published = version({
      id: "published",
      title: "公開タイトル",
      status: "published",
    });
    const draft = version({ id: "draft", title: "下書きタイトル" });

    const versions = translationVersionsForLocale([draft, published], "ja");

    expect(editableTranslation(versions).title).toBe("下書きタイトル");
  });

  it("requires a non-empty title before publishing", () => {
    expect(hasPublishableTitle(" 日本語タイトル ")).toBe(true);
    expect(hasPublishableTitle("   ")).toBe(false);
  });
});
