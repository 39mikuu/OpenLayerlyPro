import { asc, eq, inArray, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import {
  categories,
  type Category,
  type Post,
  postCategories,
  posts,
  postTags,
  type Tag,
  tags,
} from "@/db/schema";
import { ApiError } from "@/lib/api";

type CategoryInput = { name: string; slug?: string; sortOrder?: number };
type TagInput = { name: string; slug?: string };

function normalizeName(name: string): string {
  const value = name.trim();
  if (!value) throw new ApiError(400, "taxonomyNameRequired");
  return value;
}

export function slugifyTaxonomy(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new ApiError(400, "taxonomySlugRequired");
  return slug;
}

function normalizeSlug(slug: string | undefined, name: string): string {
  return slugifyTaxonomy(slug?.trim() || name);
}

function translateConstraintError(error: unknown): never {
  let current = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && (current as { code?: string }).code === "23505") {
      throw new ApiError(409, "slugTaken");
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : null;
  }
  throw error;
}

export function listCategories(dbc: DbClient = getDb()): Promise<Category[]> {
  return dbc.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.name));
}

export async function createCategory(
  input: CategoryInput,
  dbc: DbClient = getDb(),
): Promise<Category> {
  const name = normalizeName(input.name);
  try {
    const [category] = await dbc
      .insert(categories)
      .values({
        name,
        slug: normalizeSlug(input.slug, name),
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    return category;
  } catch (error) {
    translateConstraintError(error);
  }
}

export async function updateCategory(
  id: string,
  patch: Partial<CategoryInput>,
  dbc: DbClient = getDb(),
): Promise<Category> {
  const values = {
    ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
    ...(patch.slug !== undefined ? { slug: normalizeSlug(patch.slug, patch.slug) } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    updatedAt: sql`now()`,
  };
  try {
    const [category] = await dbc
      .update(categories)
      .set(values)
      .where(eq(categories.id, id))
      .returning();
    if (!category) throw new ApiError(404, "categoryNotFound");
    return category;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    translateConstraintError(error);
  }
}

export async function deleteCategory(id: string, dbc: DbClient = getDb()): Promise<void> {
  const deleted = await dbc.delete(categories).where(eq(categories.id, id)).returning();
  if (deleted.length === 0) throw new ApiError(404, "categoryNotFound");
}

export function listTags(dbc: DbClient = getDb()): Promise<Tag[]> {
  return dbc.select().from(tags).orderBy(asc(tags.name));
}

export async function createTag(input: TagInput, dbc: DbClient = getDb()): Promise<Tag> {
  const name = normalizeName(input.name);
  try {
    const [tag] = await dbc
      .insert(tags)
      .values({ name, slug: normalizeSlug(input.slug, name) })
      .returning();
    return tag;
  } catch (error) {
    translateConstraintError(error);
  }
}

export async function updateTag(
  id: string,
  patch: Partial<TagInput>,
  dbc: DbClient = getDb(),
): Promise<Tag> {
  const values = {
    ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
    ...(patch.slug !== undefined ? { slug: normalizeSlug(patch.slug, patch.slug) } : {}),
    updatedAt: sql`now()`,
  };
  try {
    const [tag] = await dbc.update(tags).set(values).where(eq(tags.id, id)).returning();
    if (!tag) throw new ApiError(404, "tagNotFound");
    return tag;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    translateConstraintError(error);
  }
}

export async function deleteTag(id: string, dbc: DbClient = getDb()): Promise<void> {
  const deleted = await dbc.delete(tags).where(eq(tags.id, id)).returning();
  if (deleted.length === 0) throw new ApiError(404, "tagNotFound");
}

async function assertPostExists(postId: string, dbc: DbClient): Promise<Post> {
  const [post] = await dbc.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) throw new ApiError(404, "postNotFound");
  return post;
}

async function assertCategoryIds(ids: string[], dbc: DbClient): Promise<void> {
  if (ids.length === 0) return;
  const rows = await dbc
    .select({ id: categories.id })
    .from(categories)
    .where(inArray(categories.id, ids));
  if (rows.length !== ids.length) throw new ApiError(400, "categoryNotFound");
}

async function assertTagIds(ids: string[], dbc: DbClient): Promise<void> {
  if (ids.length === 0) return;
  const rows = await dbc.select({ id: tags.id }).from(tags).where(inArray(tags.id, ids));
  if (rows.length !== ids.length) throw new ApiError(400, "tagNotFound");
}

async function replacePostCategories(postId: string, categoryIds: string[], dbc: DbClient) {
  const ids = [...new Set(categoryIds)];
  await assertPostExists(postId, dbc);
  await assertCategoryIds(ids, dbc);
  await dbc.delete(postCategories).where(eq(postCategories.postId, postId));
  if (ids.length > 0) {
    await dbc.insert(postCategories).values(ids.map((categoryId) => ({ postId, categoryId })));
  }
}

async function replacePostTags(postId: string, tagIds: string[], dbc: DbClient) {
  const ids = [...new Set(tagIds)];
  await assertPostExists(postId, dbc);
  await assertTagIds(ids, dbc);
  await dbc.delete(postTags).where(eq(postTags.postId, postId));
  if (ids.length > 0) {
    await dbc.insert(postTags).values(ids.map((tagId) => ({ postId, tagId })));
  }
}

export async function setPostCategories(
  postId: string,
  categoryIds: string[],
  dbc?: DbClient,
): Promise<void> {
  if (dbc) return replacePostCategories(postId, categoryIds, dbc);
  await getDb().transaction((tx) => replacePostCategories(postId, categoryIds, tx));
}

export async function setPostTags(postId: string, tagIds: string[], dbc?: DbClient): Promise<void> {
  if (dbc) return replacePostTags(postId, tagIds, dbc);
  await getDb().transaction((tx) => replacePostTags(postId, tagIds, tx));
}

export async function getPostTaxonomy(
  postId: string,
  dbc: DbClient = getDb(),
): Promise<{ categories: Category[]; tags: Tag[] }> {
  const [categoryRows, tagRows] = await Promise.all([
    dbc
      .select({ category: categories })
      .from(postCategories)
      .innerJoin(categories, eq(postCategories.categoryId, categories.id))
      .where(eq(postCategories.postId, postId))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
    dbc
      .select({ tag: tags })
      .from(postTags)
      .innerJoin(tags, eq(postTags.tagId, tags.id))
      .where(eq(postTags.postId, postId))
      .orderBy(asc(tags.name)),
  ]);
  return {
    categories: categoryRows.map((row) => row.category),
    tags: tagRows.map((row) => row.tag),
  };
}

export async function getPostsTaxonomy(
  postIds: string[],
  dbc: DbClient = getDb(),
): Promise<Map<string, { categories: Category[]; tags: Tag[] }>> {
  const result = new Map(
    postIds.map((postId) => [postId, { categories: [] as Category[], tags: [] as Tag[] }]),
  );
  if (postIds.length === 0) return result;
  const [categoryRows, tagRows] = await Promise.all([
    dbc
      .select({ postId: postCategories.postId, category: categories })
      .from(postCategories)
      .innerJoin(categories, eq(postCategories.categoryId, categories.id))
      .where(inArray(postCategories.postId, postIds))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
    dbc
      .select({ postId: postTags.postId, tag: tags })
      .from(postTags)
      .innerJoin(tags, eq(postTags.tagId, tags.id))
      .where(inArray(postTags.postId, postIds))
      .orderBy(asc(tags.name)),
  ]);
  for (const row of categoryRows) result.get(row.postId)?.categories.push(row.category);
  for (const row of tagRows) result.get(row.postId)?.tags.push(row.tag);
  return result;
}
