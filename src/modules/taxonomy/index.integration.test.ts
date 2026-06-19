import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { categories, postCategories, posts, postTags, tags } from "@/db/schema";
import { listPosts } from "@/modules/content";

import {
  createCategory,
  createTag,
  deleteCategory,
  getPostTaxonomy,
  setPostCategories,
  setPostTags,
  updateCategory,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("taxonomy integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(postCategories);
    await db.delete(postTags);
    await db.delete(posts);
    await db.delete(categories);
    await db.delete(tags);
  });

  async function seedPost(status: "draft" | "published" = "draft") {
    const [post] = await db
      .insert(posts)
      .values({
        title: "Taxonomy test",
        slug: `taxonomy-${randomUUID()}`,
        visibility: "public",
        status,
        publishedAt: status === "published" ? new Date() : null,
      })
      .returning();
    return post;
  }

  it("supports CRUD and returns a stable slug conflict", async () => {
    const category = await createCategory({ name: "News", slug: "news", sortOrder: 2 });
    const renamed = await updateCategory(category.id, { name: "Updates", sortOrder: 1 });
    expect(renamed).toMatchObject({ name: "Updates", slug: "news", sortOrder: 1 });

    await expect(createCategory({ name: "Other", slug: "news" })).rejects.toMatchObject({
      status: 409,
      code: "slugTaken",
    });
  });

  it("replaces associations idempotently without touching publishing fields", async () => {
    const post = await seedPost("draft");
    const originalContentUpdatedAt = post.contentUpdatedAt;
    const first = await createCategory({ name: "First", slug: "first" });
    const second = await createCategory({ name: "Second", slug: "second" });
    const tag = await createTag({ name: "Featured", slug: "featured" });

    await setPostCategories(post.id, [first.id, first.id, second.id]);
    await setPostCategories(post.id, [second.id]);
    await setPostTags(post.id, [tag.id, tag.id]);

    const taxonomy = await getPostTaxonomy(post.id);
    const [stored] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(taxonomy.categories.map((item) => item.id)).toEqual([second.id]);
    expect(taxonomy.tags.map((item) => item.id)).toEqual([tag.id]);
    expect(stored).toMatchObject({
      status: "draft",
      scheduledAt: null,
      contentUpdatedAt: originalContentUpdatedAt,
    });
  });

  it("deleting taxonomy cascades only the join and preserves the post", async () => {
    const post = await seedPost();
    const category = await createCategory({ name: "Temporary", slug: "temporary" });
    await setPostCategories(post.id, [category.id]);

    await deleteCategory(category.id);

    await expect(db.select().from(posts).where(eq(posts.id, post.id))).resolves.toHaveLength(1);
    await expect(
      db.select().from(postCategories).where(eq(postCategories.postId, post.id)),
    ).resolves.toHaveLength(0);
  });

  it("filters published posts by category and tag without exposing drafts", async () => {
    const published = await seedPost("published");
    const draft = await seedPost("draft");
    const category = await createCategory({ name: "Guides", slug: "guides" });
    const tag = await createTag({ name: "TypeScript", slug: "typescript" });
    await setPostCategories(published.id, [category.id]);
    await setPostCategories(draft.id, [category.id]);
    await setPostTags(published.id, [tag.id]);

    await expect(listPosts({ publishedOnly: true, categorySlug: "guides" })).resolves.toMatchObject(
      [{ id: published.id }],
    );
    await expect(listPosts({ publishedOnly: true, tagSlug: "typescript" })).resolves.toMatchObject([
      { id: published.id },
    ]);
    await expect(listPosts({ publishedOnly: true, tagSlug: "missing" })).resolves.toHaveLength(0);
  });
});
