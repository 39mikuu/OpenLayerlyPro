import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "@/db";
import { files, type PostFile, postFiles, posts, postTranslations } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { enqueueTask } from "@/modules/tasks";

import { extractInternalImageFileIds } from "./markdown";

export type AttachablePostFileKind = Exclude<PostFile["kind"], "inline">;

const ALLOWED_PURPOSES_BY_KIND: Record<PostFile["kind"], readonly string[]> = {
  inline: ["content_image"],
  image: ["content_image"],
  attachment: ["content_attachment"],
  cover: ["cover", "content_image"],
  preview: ["content_image", "cover", "thumbnail"],
  thumbnail: ["thumbnail", "content_image"],
};

export function assertPostFilePurpose(
  kind: PostFile["kind"],
  purpose: (typeof files.$inferSelect)["purpose"],
): void {
  if (!ALLOWED_PURPOSES_BY_KIND[kind].includes(purpose)) {
    throw new ApiError(400, "postFilePurposeMismatch", { kind, purpose });
  }
}

export async function enqueueOrphanCleanup(
  tx: DbClient,
  fileIds: Iterable<string>,
  options: { runAfter?: Date } = {},
): Promise<void> {
  for (const fileId of new Set(fileIds)) {
    await enqueueTask(tx, {
      kind: "file.cleanup_orphan",
      payload: { fileId },
      runAfter: options.runAfter,
    });
  }
}

async function referencedInlineIds(tx: DbClient, postId: string): Promise<Set<string>> {
  const [post] = await tx
    .select({ body: posts.body })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!post) throw new ApiError(404, "postNotFound");

  const translations = await tx
    .select({ body: postTranslations.body })
    .from(postTranslations)
    .where(
      and(
        eq(postTranslations.postId, postId),
        inArray(postTranslations.status, ["draft", "published", "archived"]),
      ),
    );

  const ids = extractInternalImageFileIds(post.body);
  for (const translation of translations) {
    for (const id of extractInternalImageFileIds(translation.body)) ids.add(id);
  }
  return ids;
}

/**
 * Reconciles body-owned inline links. Call only from a content write transaction
 * while the parent post row is locked FOR UPDATE.
 */
export async function syncInlineImageLinks(tx: DbClient, postId: string): Promise<void> {
  const desiredIds = await referencedInlineIds(tx, postId);
  const desired = [...desiredIds];

  if (desired.length > 0) {
    const records = await tx
      .select({ id: files.id, purpose: files.purpose })
      .from(files)
      .where(inArray(files.id, desired));
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const fileId of desired) {
      const record = byId.get(fileId);
      if (!record) throw new ApiError(400, "inlineImageNotFound", { fileId });
      assertPostFilePurpose("inline", record.purpose);
    }
  }

  const current = await tx
    .select({ id: postFiles.id, fileId: postFiles.fileId })
    .from(postFiles)
    .where(and(eq(postFiles.postId, postId), eq(postFiles.kind, "inline")));

  const retained = new Set<string>();
  const linkIdsToDelete: string[] = [];
  const cleanupCandidates: string[] = [];
  for (const link of current) {
    if (desiredIds.has(link.fileId) && !retained.has(link.fileId)) {
      retained.add(link.fileId);
    } else {
      linkIdsToDelete.push(link.id);
      cleanupCandidates.push(link.fileId);
    }
  }

  const missing = desired.filter((fileId) => !retained.has(fileId));
  if (missing.length > 0) {
    await tx.insert(postFiles).values(
      missing.map((fileId, index) => ({
        postId,
        fileId,
        kind: "inline" as const,
        sortOrder: index,
      })),
    );
  }

  if (linkIdsToDelete.length > 0) {
    await tx.delete(postFiles).where(inArray(postFiles.id, linkIdsToDelete));
    await enqueueOrphanCleanup(tx, cleanupCandidates);
  }
}
