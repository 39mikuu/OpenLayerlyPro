import { and, desc, eq } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { posts, postTranslations } from "@/db/schema";

export type TranslationReviewItem = {
  postId: string;
  postTitle: string;
  originalLocale: string;
  originalTitle: string;
  originalSummary: string | null;
  originalBody: string | null;
  postUpdatedAt: Date;
  translationId: string;
  locale: string;
  title: string;
  summary: string | null;
  body: string | null;
  sourceUpdatedAt: Date | null;
  translationUpdatedAt: Date;
  stale: boolean;
};

export function isTranslationStale(postUpdatedAt: Date, sourceUpdatedAt: Date | null): boolean {
  return sourceUpdatedAt === null || postUpdatedAt.getTime() > sourceUpdatedAt.getTime();
}

export async function listMachineTranslationDrafts(
  dbc: DbClient = getDb(),
): Promise<TranslationReviewItem[]> {
  const rows = await dbc
    .select({
      postId: posts.id,
      postTitle: posts.title,
      originalLocale: posts.originalLocale,
      originalTitle: posts.title,
      originalSummary: posts.summary,
      originalBody: posts.body,
      postUpdatedAt: posts.updatedAt,
      translationId: postTranslations.id,
      locale: postTranslations.locale,
      title: postTranslations.title,
      summary: postTranslations.summary,
      body: postTranslations.body,
      sourceUpdatedAt: postTranslations.sourceUpdatedAt,
      translationUpdatedAt: postTranslations.updatedAt,
    })
    .from(postTranslations)
    .innerJoin(posts, eq(postTranslations.postId, posts.id))
    .where(and(eq(postTranslations.status, "draft"), eq(postTranslations.source, "machine")))
    .orderBy(desc(postTranslations.updatedAt));

  return rows.map((row) => ({
    ...row,
    stale: isTranslationStale(row.postUpdatedAt, row.sourceUpdatedAt),
  }));
}
