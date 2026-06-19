import { describe, expect, it, vi } from "vitest";

import type { Post, PostTranslation } from "@/db/schema";

import {
  decodeCursor,
  encodeCursor,
  getLocalizedPost,
  localizePostCards,
  publishTranslation,
  unpublishTranslation,
  upsertDraftTranslation,
} from "./index";

describe("published post cursor", () => {
  it("round-trips a full-precision timestamp and UUID", () => {
    const cursor = {
      publishedAt: "2026-06-19T12:34:56.123456Z",
      id: "11111111-1111-4111-8111-111111111111",
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects a semantically impossible full-precision timestamp", () => {
    const cursor = encodeCursor({
      publishedAt: "2026-99-99T99:99:99.999999Z",
      id: "11111111-1111-4111-8111-111111111111",
    });

    expect(decodeCursor(cursor)).toBeNull();
  });

  it("accepts canonical UUID text without version or variant restrictions", () => {
    const cursor = {
      publishedAt: "2026-06-19T12:34:56.123456Z",
      id: "11111111-1111-0111-0111-111111111111",
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["not-base64"],
    [encodeCursor({ publishedAt: "2026-06-19T12:34:56.123Z", id: "not-a-uuid" })],
    [null],
  ])("safely rejects an invalid cursor", (cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: "post-1",
    title: "原文标题",
    slug: "original",
    summary: "原文摘要",
    body: "原文正文",
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
    ...overrides,
  };
}

function translation(overrides: Partial<PostTranslation> = {}): PostTranslation {
  return {
    id: "translation-1",
    postId: "post-1",
    locale: "ja",
    title: "翻訳タイトル",
    summary: "翻訳概要",
    body: "翻訳本文",
    status: "published",
    source: "manual",
    sourceUpdatedAt: new Date("2026-02-01T00:00:00Z"),
    publishedAt: new Date("2026-02-02T00:00:00Z"),
    createdAt: new Date("2026-02-01T00:00:00Z"),
    updatedAt: new Date("2026-02-02T00:00:00Z"),
    ...overrides,
  };
}

function fakeDb(options: {
  selectResults?: unknown[][];
  updateResults?: unknown[][];
  insertResults?: unknown[][];
}) {
  const selectResults = [...(options.selectResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const events: string[] = [];
  const inserted: unknown[] = [];
  const updated: unknown[] = [];

  function terminal(result: unknown[]) {
    const value = {
      limit: vi.fn(async () => result),
      orderBy: vi.fn(() => value),
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return value;
  }

  const db = {
    select: vi.fn(() => {
      const result = selectResults.shift() ?? [];
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => terminal(result)),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updated.push(values);
        events.push(`update:${String((values as { status?: string }).status ?? "fields")}`);
        return {
          where: vi.fn(() => {
            const result = updateResults.shift() ?? [];
            const value = terminal([]);
            return Object.assign(value, { returning: vi.fn(async () => result) });
          }),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        inserted.push(values);
        return { returning: vi.fn(async () => insertResults.shift() ?? []) };
      }),
    })),
    delete: vi.fn(),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };

  return { db, events, inserted, updated };
}

describe("content localization", () => {
  it("returns the original content for its original locale", async () => {
    const fake = fakeDb({});
    const localized = await getLocalizedPost(post(), "zh", fake.db as never);

    expect(localized.title).toBe("原文标题");
    expect(localized.contentLocale).toBe("zh");
    expect(localized.isFallback).toBe(false);
    expect(fake.db.select).not.toHaveBeenCalled();
  });

  it.each([
    ["ja", "翻訳タイトル"],
    ["en", "Translated title"],
  ] as const)("uses a published %s translation", async (locale, title) => {
    const fake = fakeDb({
      selectResults: [[translation({ locale, title })]],
    });
    const localized = await getLocalizedPost(post(), locale, fake.db as never);

    expect(localized.title).toBe(title);
    expect(localized.contentLocale).toBe(locale);
    expect(localized.isFallback).toBe(false);
    expect(localized.translationSource).toBe("manual");
  });

  it("exposes the source of a published Japanese machine translation", async () => {
    const fake = fakeDb({
      selectResults: [[translation({ locale: "ja", source: "machine" })]],
    });

    const localized = await getLocalizedPost(post(), "ja", fake.db as never);

    expect(localized.translationSource).toBe("machine");
  });

  it("falls back to the original when no published translation exists", async () => {
    const fake = fakeDb({ selectResults: [[]] });
    const localized = await getLocalizedPost(post(), "ja", fake.db as never);

    expect(localized.title).toBe("原文标题");
    expect(localized.contentLocale).toBe("zh");
    expect(localized.isFallback).toBe(true);
  });

  it.each(["draft", "archived"] as const)("does not expose a %s translation", async (status) => {
    const fake = fakeDb({
      selectResults: [[translation({ status, publishedAt: null })]],
    });
    const localized = await getLocalizedPost(post(), "ja", fake.db as never);

    expect(localized.title).toBe("原文标题");
    expect(localized.contentLocale).toBe("zh");
    expect(localized.isFallback).toBe(true);
  });

  it("localizes a list with one batch query and falls back per post", async () => {
    const posts = [post(), post({ id: "post-2", title: "第二篇", slug: "second" })];
    const fake = fakeDb({
      selectResults: [[translation({ postId: "post-1" })]],
    });

    const localized = await localizePostCards(posts, "ja", fake.db as never);

    expect(fake.db.select).toHaveBeenCalledTimes(1);
    expect(localized.map((item) => item.title)).toEqual(["翻訳タイトル", "第二篇"]);
    expect(localized.map((item) => item.isFallback)).toEqual([false, true]);
  });

  it("does not expose draft translations in localized card lists", async () => {
    const source = post();
    const fake = fakeDb({
      selectResults: [[translation({ status: "draft", publishedAt: null })]],
    });

    const localized = await localizePostCards([source], "ja", fake.db as never);

    expect(localized[0]).toMatchObject({
      title: "原文标题",
      contentLocale: "zh",
      isFallback: true,
      translationSource: null,
    });
  });
});

describe("translation lifecycle", () => {
  it("upserts a draft with the source post content timestamp", async () => {
    const sourcePost = post();
    const created = translation({
      status: "draft",
      publishedAt: null,
      sourceUpdatedAt: sourcePost.contentUpdatedAt,
    });
    const fake = fakeDb({
      selectResults: [[sourcePost], []],
      insertResults: [[created]],
    });

    const result = await upsertDraftTranslation(
      sourcePost.id,
      "ja",
      { title: "下書き", source: "machine" },
      fake.db as never,
    );

    expect(result).toEqual(created);
    expect(fake.inserted[0]).toMatchObject({
      postId: sourcePost.id,
      locale: "ja",
      title: "下書き",
      source: "machine",
      sourceUpdatedAt: sourcePost.contentUpdatedAt,
    });
  });

  it("updates the existing working draft instead of inserting another one", async () => {
    const sourcePost = post();
    const existing = translation({ id: "draft-1", status: "draft", publishedAt: null });
    const updated = translation({
      id: "draft-1",
      title: "更新后的下書き",
      status: "draft",
      publishedAt: null,
    });
    const fake = fakeDb({
      selectResults: [[sourcePost], [existing]],
      updateResults: [[updated]],
    });

    const result = await upsertDraftTranslation(
      sourcePost.id,
      "ja",
      { title: "更新后的下書き" },
      fake.db as never,
    );

    expect(result).toEqual(updated);
    expect(fake.db.insert).not.toHaveBeenCalled();
    expect(fake.updated[0]).toMatchObject({
      title: "更新后的下書き",
      sourceUpdatedAt: sourcePost.contentUpdatedAt,
    });
  });

  it.each([
    ["fr", "unsupportedLocale"],
    ["zh", "translationOriginalLocale"],
  ] as const)("rejects invalid translation locale %s", async (locale, code) => {
    const fake = fakeDb({
      selectResults: locale === "zh" ? [[post()]] : [],
    });

    await expect(
      upsertDraftTranslation("post-1", locale, { title: "Draft" }, fake.db as never),
    ).rejects.toMatchObject({
      status: 400,
      code,
    });
    expect(fake.db.insert).not.toHaveBeenCalled();
  });

  it("rejects an empty draft title", async () => {
    const fake = fakeDb({ selectResults: [[post()]] });

    await expect(
      upsertDraftTranslation("post-1", "ja", { title: "   " }, fake.db as never),
    ).rejects.toMatchObject({
      status: 400,
      code: "translationTitleRequired",
    });
    expect(fake.db.insert).not.toHaveBeenCalled();
  });

  it("archives the old published version before promoting the draft", async () => {
    const draft = translation({ id: "draft-1", status: "draft", publishedAt: null });
    const published = translation({ id: "draft-1", status: "published" });
    const fake = fakeDb({
      selectResults: [[post()], [draft]],
      updateResults: [[], [published]],
    });

    const result = await publishTranslation("post-1", "ja", fake.db as never);

    expect(fake.events).toEqual(["update:archived", "update:published"]);
    expect(fake.updated[1]).toMatchObject({
      status: "published",
      publishedAt: expect.any(Date),
    });
    expect(result).toEqual(published);
    expect(fake.db.transaction).toHaveBeenCalledTimes(1);
  });

  it("requires a translated body when the original body is non-empty", async () => {
    const draft = translation({
      status: "draft",
      body: " ",
      publishedAt: null,
    });
    const fake = fakeDb({
      selectResults: [[post({ body: "原文正文" })], [draft]],
    });

    await expect(publishTranslation("post-1", "ja", fake.db as never)).rejects.toMatchObject({
      status: 400,
      code: "translationBodyRequired",
    });
    expect(fake.db.update).not.toHaveBeenCalled();
  });

  it("falls back to the original after a Japanese translation is unpublished", async () => {
    const sourcePost = post();
    const fake = fakeDb({
      selectResults: [[sourcePost], []],
    });

    await unpublishTranslation(sourcePost.id, "ja", fake.db as never);
    const localized = await getLocalizedPost(sourcePost, "ja", fake.db as never);

    expect(fake.events).toContain("update:archived");
    expect(localized).toMatchObject({
      title: "原文标题",
      contentLocale: "zh",
      isFallback: true,
    });
  });
});
