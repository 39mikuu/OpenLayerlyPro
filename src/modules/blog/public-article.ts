import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { posts } from "@/db/schema";

export async function isPublishedPublicBlogArticle(slug: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.slug, slug), eq(posts.status, "published"), eq(posts.visibility, "public")))
    .limit(1);
  return Boolean(row);
}
