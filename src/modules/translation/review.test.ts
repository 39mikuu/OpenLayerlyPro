import { describe, expect, it, vi } from "vitest";

import { isTranslationStale, listMachineTranslationDrafts } from "./review";

function fakeDb(rows: unknown[]) {
  const terminal = {
    orderBy: vi.fn(async () => rows),
  };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => terminal),
        })),
      })),
    })),
  };
  return db;
}

describe("translation review queue", () => {
  it("marks a Japanese machine draft stale when the source post changed", async () => {
    const sourceUpdatedAt = new Date("2026-02-01T00:00:00Z");
    const postUpdatedAt = new Date("2026-02-02T00:00:00Z");
    const row = {
      postId: "post-1",
      postTitle: "原文标题",
      originalLocale: "zh",
      originalTitle: "原文标题",
      originalSummary: "原文摘要",
      originalBody: "原文正文",
      postUpdatedAt,
      translationId: "translation-ja",
      locale: "ja",
      title: "日本語タイトル",
      summary: "日本語概要",
      body: "日本語本文",
      sourceUpdatedAt,
      translationUpdatedAt: sourceUpdatedAt,
    };

    const items = await listMachineTranslationDrafts(fakeDb([row]) as never);

    expect(items).toEqual([{ ...row, stale: true }]);
    expect(items[0]).toMatchObject({ locale: "ja", title: "日本語タイトル" });
  });

  it("does not mark a draft stale when it matches the current source", () => {
    const updatedAt = new Date("2026-02-01T00:00:00Z");
    expect(isTranslationStale(updatedAt, updatedAt)).toBe(false);
  });

  it("treats a missing source timestamp as stale", () => {
    expect(isTranslationStale(new Date(), null)).toBe(true);
  });
});
