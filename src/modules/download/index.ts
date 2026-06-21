import { desc, eq } from "drizzle-orm";
import type { Readable } from "stream";

import { getDb } from "@/db";
import { downloadLogs, type FileRecord, files, type Post, type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import {
  canAccessPost,
  listPostIdsWithPublishedInlineImageReference,
  listPostLinksForFile,
  listPostsForFile,
} from "@/modules/content";
import { getStorageForDriver } from "@/modules/storage";
import { recordEvent } from "@/modules/system/events";

import type { ByteRange } from "./range";
import { isInlineVideoMime } from "./video";

const SIGNED_URL_TTL_SECONDS = 5 * 60;

export type AuthorizedFileAccess = {
  postId: string | null;
  visibility: "public" | "login" | "member" | null;
};

type FileAccessDecision =
  | ({ allowed: true } & AuthorizedFileAccess)
  | { allowed: false; errorCode: string };

async function findGrantingPost(
  user: User | null,
  candidates: readonly Post[],
): Promise<Post | null> {
  const published = candidates.filter((post) => post.status === "published");
  const ordered = [
    ...published.filter((post) => post.visibility === "public"),
    ...published.filter((post) => post.visibility !== "public"),
  ];
  const checked = new Set<string>();
  for (const post of ordered) {
    if (checked.has(post.id)) continue;
    checked.add(post.id);
    if (await canAccessPost(user, post)) return post;
  }
  return null;
}

async function resolveFileAccess(user: User | null, file: FileRecord): Promise<FileAccessDecision> {
  if (user?.role === "admin") {
    const posts = await listPostsForFile(file.id);
    return { allowed: true, postId: posts[0]?.id ?? null, visibility: null };
  }

  switch (file.purpose) {
    case "artist_avatar":
    case "payment_qr":
    case "cover":
    case "thumbnail":
      return { allowed: true, postId: null, visibility: null };
    case "payment_proof": {
      if (!user) return { allowed: false, errorCode: "authRequired" };
      if (file.createdBy === user.id) {
        return { allowed: true, postId: null, visibility: null };
      }
      return { allowed: false, errorCode: "accessDenied" };
    }
    case "content_attachment": {
      const linkedPosts = await listPostsForFile(file.id);
      if (linkedPosts.length === 0) return { allowed: false, errorCode: "fileUnlinked" };
      const grantingPost = await findGrantingPost(user, linkedPosts);
      if (grantingPost) {
        return {
          allowed: true,
          postId: grantingPost.id,
          visibility: grantingPost.visibility,
        };
      }
      if (!user) return { allowed: false, errorCode: "authRequired" };
      return { allowed: false, errorCode: "memberAccessDenied" };
    }
    case "content_image": {
      const links = await listPostLinksForFile(file.id);
      if (links.length === 0) return { allowed: false, errorCode: "fileUnlinked" };

      const nonInlinePosts = [
        ...new Map(
          links
            .filter((link) => link.kind !== "inline")
            .map((link) => [link.post.id, link.post] as const),
        ).values(),
      ];
      const nonInlineGrant = await findGrantingPost(user, nonInlinePosts);
      if (nonInlineGrant) {
        return {
          allowed: true,
          postId: nonInlineGrant.id,
          visibility: nonInlineGrant.visibility,
        };
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
      const inlineGrant = await findGrantingPost(
        user,
        inlinePosts.filter((post) => publishedReferencePostIds.has(post.id)),
      );
      if (inlineGrant) {
        return {
          allowed: true,
          postId: inlineGrant.id,
          visibility: inlineGrant.visibility,
        };
      }

      if (!user) return { allowed: false, errorCode: "authRequired" };
      return { allowed: false, errorCode: "memberAccessDenied" };
    }
    default:
      return { allowed: false, errorCode: "accessDenied" };
  }
}

/** Compatibility API retained for existing callers and exact object assertions. */
export async function canAccessFile(
  user: User | null,
  file: FileRecord,
): Promise<{ allowed: boolean; postId?: string | null; errorCode?: string }> {
  const decision = await resolveFileAccess(user, file);
  if (!decision.allowed) return decision;
  if (decision.postId !== null) return { allowed: true, postId: decision.postId };
  if (user?.role === "admin") return { allowed: true, postId: null };
  return { allowed: true };
}

export async function authorizeFileAccess(
  user: User | null,
  file: FileRecord,
): Promise<AuthorizedFileAccess> {
  const decision = await resolveFileAccess(user, file);
  if (!decision.allowed) {
    throw new ApiError(user ? 403 : 401, decision.errorCode ?? "accessDenied");
  }
  return { postId: decision.postId, visibility: decision.visibility };
}

export function shouldLogInitialFileRequest(file: FileRecord, range: ByteRange | null): boolean {
  const loggable = file.purpose === "content_attachment" || file.purpose === "content_image";
  return loggable && (range === null || range.start === 0);
}

export type DownloadResult =
  | { mode: "stream"; stream: Readable; file: FileRecord }
  | { mode: "redirect"; url: string };

export async function prepareAuthorizedDownload(input: {
  user: User | null;
  file: FileRecord;
  access: AuthorizedFileAccess;
  range?: ByteRange;
  inline: boolean;
  log: boolean;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<DownloadResult> {
  const { user, file, access } = input;
  if (input.log) {
    await getDb()
      .insert(downloadLogs)
      .values({
        userId: user?.id ?? null,
        postId: access.postId,
        fileId: file.id,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        storageDriver: file.storageDriver,
      });
    await recordEvent("file_downloaded", { fileId: file.id, userId: user?.id ?? null });
  }

  const storage = await getStorageForDriver(file.storageDriver);
  const video = file.purpose === "content_attachment" && isInlineVideoMime(file.mimeType);
  if (file.storageDriver === "s3" && storage.createSignedDownloadUrl) {
    if (video && input.inline && access.visibility === "public") {
      const url = await storage.createSignedDownloadUrl({
        objectKey: file.objectKey,
        bucket: file.bucket,
        expiresInSeconds: getEnv().PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS,
        downloadName: file.originalName,
        disposition: "inline",
        contentType: file.mimeType,
      });
      return { mode: "redirect", url };
    }

    const privateVideo = video && access.visibility !== "public";
    if (!privateVideo) {
      const url = await storage.createSignedDownloadUrl({
        objectKey: file.objectKey,
        bucket: file.bucket,
        expiresInSeconds: SIGNED_URL_TTL_SECONDS,
        downloadName: file.originalName,
        disposition: "attachment",
        contentType: file.mimeType,
      });
      return { mode: "redirect", url };
    }
  }

  const stream = await storage.getObject({
    objectKey: file.objectKey,
    bucket: file.bucket,
    start: input.range?.start,
    end: input.range?.end,
  });
  return { mode: "stream", stream, file };
}

/** Backward-compatible wrapper for non-Range callers. */
export async function authorizeAndPrepareDownload(input: {
  user: User | null;
  file: FileRecord;
  ip?: string | null;
  userAgent?: string | null;
  log?: boolean;
}): Promise<DownloadResult> {
  const access = await authorizeFileAccess(input.user, input.file);
  return prepareAuthorizedDownload({
    ...input,
    access,
    inline: false,
    log: input.log !== false,
  });
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
