import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { categories, postCategories, posts, postTags, tags } from "@/db/schema";
import { createCategory, createTag, setPostCategories, setPostTags } from "@/modules/taxonomy";

import { encodeCursor, listPublishedPostsPage } from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("published post pagination integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(postCategories);
    await db.delete(postTags);
    await db.delete(posts);
    await db.delete(categories);
    await db.delete(tags);
  });

  async function seedPrecisePost(
    publishedAt: string,
    options: {
      id?: string;
      status?: "draft" | "published";
    } = {},
  ): Promise<string> {
    const id = options.id ?? randomUUID();
    const status = options.status ?? "published";
    const published = status === "published";
    await db.execute(sql`
      insert into posts (
        id, title, slug, visibility, status, published_at
      ) values (
        ${id}::uuid,
        ${`Post ${id}`},
        ${`post-${id}`},
        'public',
        ${status},
        ${published ? sql`${publishedAt}::timestamptz` : sql`null`}
      )
    `);
    return id;
  }

  async function collectIds(limit: number): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listPublishedPostsPage({ limit, cursor });
      ids.push(...page.posts.map((post) => post.id));
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  }

  it("walks every row without duplicates and returns null on the last page", async () => {
    const ids = await Promise.all([
      seedPrecisePost("2026-06-19T12:00:05.000005Z"),
      seedPrecisePost("2026-06-19T12:00:04.000004Z"),
      seedPrecisePost("2026-06-19T12:00:03.000003Z"),
      seedPrecisePost("2026-06-19T12:00:02.000002Z"),
      seedPrecisePost("2026-06-19T12:00:01.000001Z"),
    ]);

    expect(await collectIds(2)).toEqual(ids);
    const lastPage = await listPublishedPostsPage({ limit: 10 });
    expect(lastPage.nextCursor).toBeNull();
  });

  it("preserves microseconds and uses the UUID as a stable tie-breaker", async () => {
    const highId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const lowId = "00000000-0000-4000-8000-000000000001";
    const expected = [
      await seedPrecisePost("2026-06-19T12:00:00.000900Z"),
      await seedPrecisePost("2026-06-19T12:00:00.000500Z", { id: highId }),
      await seedPrecisePost("2026-06-19T12:00:00.000500Z", { id: lowId }),
      await seedPrecisePost("2026-06-19T12:00:00.000100Z"),
    ];

    expect(await collectIds(1)).toEqual(expected);
  });

  it("treats a semantically invalid timestamp cursor as page one", async () => {
    const newest = await seedPrecisePost("2026-06-19T12:00:02.000002Z");
    await seedPrecisePost("2026-06-19T12:00:01.000001Z");
    const invalidCursor = encodeCursor({
      publishedAt: "2026-99-99T99:99:99.999999Z",
      id: "11111111-1111-4111-8111-111111111111",
    });

    const page = await listPublishedPostsPage({ limit: 1, cursor: invalidCursor });

    expect(page.posts.map((post) => post.id)).toEqual([newest]);
  });

  it("does not repeat or skip older rows when a newer post is inserted between pages", async () => {
    const newest = await seedPrecisePost("2026-06-19T12:00:03.000000Z");
    const middle = await seedPrecisePost("2026-06-19T12:00:02.000000Z");
    const oldest = await seedPrecisePost("2026-06-19T12:00:01.000000Z");
    const first = await listPublishedPostsPage({ limit: 2 });
    expect(first.posts.map((post) => post.id)).toEqual([newest, middle]);

    await seedPrecisePost("2026-06-19T12:00:04.000000Z");
    const second = await listPublishedPostsPage({ limit: 2, cursor: first.nextCursor });

    expect(second.posts.map((post) => post.id)).toEqual([oldest]);
    expect(second.nextCursor).toBeNull();
  });

  it("composes category and tag filters, excludes drafts, and treats invalid cursors as page one", async () => {
    const included = await seedPrecisePost("2026-06-19T12:00:03.000000Z");
    const other = await seedPrecisePost("2026-06-19T12:00:02.000000Z");
    const draft = await seedPrecisePost("2026-06-19T12:00:04.000000Z", { status: "draft" });
    const category = await createCategory({ name: "Guides", slug: "guides" });
    const tag = await createTag({ name: "TypeScript", slug: "typescript" });
    await setPostCategories(included, [category.id]);
    await setPostTags(included, [tag.id]);
    await setPostCategories(draft, [category.id]);

    const filtered = await listPublishedPostsPage({
      categorySlug: "guides",
      tagSlug: "typescript",
      cursor: "invalid",
    });
    const firstPage = await listPublishedPostsPage({ limit: 1, cursor: "invalid" });

    expect(filtered.posts.map((post) => post.id)).toEqual([included]);
    expect(firstPage.posts.map((post) => post.id)).toEqual([included]);
    expect(firstPage.posts.map((post) => post.id)).not.toContain(other);
    expect(filtered.posts.map((post) => post.id)).not.toContain(draft);
  });
});
