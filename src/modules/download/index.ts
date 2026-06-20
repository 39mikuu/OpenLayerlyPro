import { desc, eq } from "drizzle-orm";
import type { Readable } from "stream";

import { getDb } from "@/db";
import { downloadLogs, type FileRecord, files, type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import {
  canAccessPost,
  listPostIdsWithPublishedInlineImageReference,
  listPostLinksForFile,
  listPostsForFile,
} from "@/modules/content";
import { getStorageForDriver } from "@/modules/storage";
import { recordEvent } from "@/modules/system/events";

const SIGNED_URL_TTL_SECONDS = 5 * 60;

/**
 * 按 file.purpose 分流的文件访问鉴权：
 * - artist_avatar / payment_qr：公开
 * - cover / thumbnail：公开预览
 * - payment_proof：仅本人或 admin
 * - content_image / content_attachment：按关联 post 权限（published + canAccessPost）
 */
export async function canAccessFile(
  user: User | null,
  file: FileRecord,
): Promise<{ allowed: boolean; postId?: string | null; errorCode?: string }> {
  if (user?.role === "admin") {
    const posts = await listPostsForFile(file.id);
    return { allowed: true, postId: posts[0]?.id ?? null };
  }

  switch (file.purpose) {
    case "artist_avatar":
    case "payment_qr":
    case "cover":
    case "thumbnail":
      return { allowed: true };
    case "payment_proof": {
      if (!user) return { allowed: false, errorCode: "authRequired" };
      if (file.createdBy === user.id) return { allowed: true };
      return { allowed: false, errorCode: "accessDenied" };
    }
    case "content_attachment": {
      const linkedPosts = await listPostsForFile(file.id);
      if (linkedPosts.length === 0) return { allowed: false, errorCode: "fileUnlinked" };
      for (const post of linkedPosts) {
        if (post.status !== "published") continue;
        if (await canAccessPost(user, post)) {
          return { allowed: true, postId: post.id };
        }
      }
      if (!user) return { allowed: false, errorCode: "authRequired" };
      return { allowed: false, errorCode: "memberAccessDenied" };
    }
    case "content_image": {
      const links = await listPostLinksForFile(file.id);
      if (links.length === 0) return { allowed: false, errorCode: "fileUnlinked" };

      const checkedNonInlinePostIds = new Set<string>();
      for (const link of links) {
        if (link.kind === "inline" || checkedNonInlinePostIds.has(link.post.id)) continue;
        checkedNonInlinePostIds.add(link.post.id);
        if (link.post.status !== "published") continue;
        if (await canAccessPost(user, link.post)) {
          return { allowed: true, postId: link.post.id };
        }
      }

      const inlinePosts = [
        ...new Map(
          links
            .filter((link) => link.kind === "inline" && link.post.status === "published")
            .map((link) => [link.post.id, link.post] as const),
        ).values(),
      ];
      const publishedReferencePostIds = await listPostIdsWithPublishedInlineImageReference(
        file.id,
        inlinePosts,
      );
      for (const post of inlinePosts) {
        if (!publishedReferencePostIds.has(post.id)) continue;
        if (await canAccessPost(user, post)) {
          return { allowed: true, postId: post.id };
        }
      }

      if (!user) return { allowed: false, errorCode: "authRequired" };
      return { allowed: false, errorCode: "memberAccessDenied" };
    }
    default:
      return { allowed: false, errorCode: "accessDenied" };
  }
}

export type DownloadResult =
  | { mode: "stream"; stream: Readable; file: FileRecord }
  | { mode: "redirect"; url: string };

export async function authorizeAndPrepareDownload(input: {
  user: User | null;
  file: FileRecord;
  ip?: string | null;
  userAgent?: string | null;
  log?: boolean;
}): Promise<DownloadResult> {
  const { user, file } = input;
  const access = await canAccessFile(user, file);
  if (!access.allowed) {
    throw new ApiError(user ? 403 : 401, access.errorCode ?? "accessDenied");
  }

  if (input.log !== false) {
    await getDb()
      .insert(downloadLogs)
      .values({
        userId: user?.id ?? null,
        postId: access.postId ?? null,
        fileId: file.id,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        storageDriver: file.storageDriver,
      });
    await recordEvent("file_downloaded", { fileId: file.id, userId: user?.id ?? null });
  }

  const storage = await getStorageForDriver(file.storageDriver);
  if (file.storageDriver === "s3" && storage.createSignedDownloadUrl) {
    const url = await storage.createSignedDownloadUrl({
      objectKey: file.objectKey,
      bucket: file.bucket,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      downloadName: file.originalName,
    });
    return { mode: "redirect", url };
  }
  const stream = await storage.getObject({ objectKey: file.objectKey, bucket: file.bucket });
  return { mode: "stream", stream, file };
}

export async function listDownloadLogs(): Promise<
  { log: typeof downloadLogs.$inferSelect; userEmail: string | null; fileName: string | null }[]
> {
  return getDb()
    .select({ log: downloadLogs, userEmail: users.email, fileName: files.originalName })
    .from(downloadLogs)
    .leftJoin(users, eq(downloadLogs.userId, users.id))
    .leftJoin(files, eq(downloadLogs.fileId, files.id))
    .orderBy(desc(downloadLogs.createdAt))
    .limit(200);
}
