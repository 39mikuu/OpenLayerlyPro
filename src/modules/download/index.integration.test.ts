import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { Readable } from "stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  getObject: vi.fn(),
  createSignedDownloadUrl: vi.fn(),
}));

vi.mock("@/modules/storage", () => ({
  getStorageForDriver: vi.fn(async (driver: "local" | "s3") => ({
    driver,
    putObject: vi.fn(),
    getObject: storageMocks.getObject,
    deleteObject: vi.fn(),
    ...(driver === "s3" ? { createSignedDownloadUrl: storageMocks.createSignedDownloadUrl } : {}),
  })),
}));

import { getDb } from "@/db";
import {
  appEvents,
  downloadLogs,
  type FileRecord,
  files,
  memberships,
  membershipTiers,
  postFiles,
  posts,
  postTranslations,
  type User,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { canAccessPost } from "@/modules/content";
import { getActiveMembership } from "@/modules/membership";

import {
  authorizeAndPrepareDownload,
  authorizeFileAccess,
  canAccessFile,
  prepareAuthorizedDownload,
  shouldLogInitialFileRequest,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("private file download authorization integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    vi.clearAllMocks();
    storageMocks.getObject.mockResolvedValue(Readable.from(["file body"]));
    storageMocks.createSignedDownloadUrl.mockResolvedValue("https://storage.example/signed");
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seedUsers() {
    const [admin, owner, other] = await db
      .insert(users)
      .values([
        { email: `admin-${randomUUID()}@example.test`, role: "admin" },
        { email: `owner-${randomUUID()}@example.test` },
        { email: `other-${randomUUID()}@example.test` },
      ])
      .returning();
    return { admin: admin!, owner: owner!, other: other! };
  }

  async function seedFile(
    purpose: FileRecord["purpose"],
    createdBy: string | null = null,
    storageDriver: FileRecord["storageDriver"] = "local",
    mimeType = "application/octet-stream",
  ): Promise<FileRecord> {
    const [file] = await db
      .insert(files)
      .values({
        storageDriver,
        bucket: storageDriver === "s3" ? "private" : null,
        objectKey: `${purpose}/${randomUUID()}`,
        originalName: mimeType.startsWith("video/") ? "video.mp4" : `${purpose}.bin`,
        mimeType,
        sizeBytes: 9,
        purpose,
        createdBy,
      })
      .returning();
    return file!;
  }

  async function seedTier(level: number, isActive = true) {
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: `Tier ${level}`,
        slug: `tier-${level}-${randomUUID()}`,
        priceLabel: String(level),
        level,
        durationDays: 31,
        isActive,
      })
      .returning();
    return tier!;
  }

  async function seedMembership(
    user: User,
    tierId: string,
    options: {
      status?: "active" | "suspended" | "revoked";
      startsAt?: Date;
      endsAt?: Date;
    } = {},
  ) {
    const now = Date.now();
    await db.insert(memberships).values({
      userId: user.id,
      tierId,
      source: "manual",
      status: options.status ?? "active",
      startsAt: options.startsAt ?? new Date(now - 60_000),
      endsAt: options.endsAt ?? new Date(now + 86_400_000),
    });
  }

  async function seedPostFile(input: {
    purpose?: "content_image" | "content_attachment";
    kind?: "inline" | "image" | "attachment";
    body?: string | null;
    visibility?: "public" | "login" | "member";
    requiredTierId?: string | null;
    state?: "draft" | "scheduled" | "published" | "archived";
    storageDriver?: "local" | "s3";
    mimeType?: string;
  }) {
    const state = input.state ?? "published";
    const scheduled = state === "scheduled";
    const [post] = await db
      .insert(posts)
      .values({
        title: `${state} post`,
        slug: `${state}-${randomUUID()}`,
        body: input.body ?? null,
        visibility: input.visibility ?? "public",
        requiredTierId: input.requiredTierId ?? null,
        status: state === "scheduled" ? "draft" : state,
        publishedAt: state === "published" ? new Date() : null,
        scheduledAt: scheduled ? new Date(Date.now() + 60_000) : null,
        scheduleToken: scheduled ? randomUUID() : null,
      })
      .returning();
    const file = await seedFile(
      input.purpose ?? "content_attachment",
      null,
      input.storageDriver,
      input.mimeType,
    );
    await db.insert(postFiles).values({
      postId: post!.id,
      fileId: file.id,
      kind: input.kind ?? (file.purpose === "content_image" ? "image" : "attachment"),
    });
    return { post: post!, file };
  }

  function markdownImage(fileId: string): string {
    return `![inline](/api/files/${fileId}/download)`;
  }

  async function seedTranslation(input: {
    postId: string;
    fileId: string;
    status: "draft" | "published" | "archived";
    locale?: string;
  }) {
    const [translation] = await db
      .insert(postTranslations)
      .values({
        postId: input.postId,
        locale: input.locale ?? "ja",
        title: `${input.status} translation`,
        body: markdownImage(input.fileId),
        status: input.status,
        publishedAt: input.status === "published" ? new Date() : null,
      })
      .returning();
    return translation!;
  }

  it("allows anonymous access to public-purpose assets", async () => {
    for (const purpose of ["artist_avatar", "payment_qr", "cover", "thumbnail"] as const) {
      const file = await seedFile(purpose);
      await expect(canAccessFile(null, file)).resolves.toEqual({ allowed: true });
    }
  });

  it("restricts payment proofs to their owner and administrators", async () => {
    const { admin, owner, other } = await seedUsers();
    const proof = await seedFile("payment_proof", owner.id);

    await expect(canAccessFile(null, proof)).resolves.toEqual({
      allowed: false,
      errorCode: "authRequired",
    });
    await expect(canAccessFile(other, proof)).resolves.toEqual({
      allowed: false,
      errorCode: "accessDenied",
    });
    await expect(canAccessFile(owner, proof)).resolves.toEqual({ allowed: true });
    await expect(canAccessFile(admin, proof)).resolves.toEqual({
      allowed: true,
      postId: null,
    });
  });

  it("denies unlinked and non-published content files while administrators retain access", async () => {
    const { admin, owner } = await seedUsers();
    const tier = await seedTier(10);
    await seedMembership(owner, tier.id);

    for (const purpose of ["content_image", "content_attachment"] as const) {
      const unlinked = await seedFile(purpose);
      await expect(canAccessFile(owner, unlinked)).resolves.toEqual({
        allowed: false,
        errorCode: "fileUnlinked",
      });
      await expect(canAccessFile(admin, unlinked)).resolves.toEqual({
        allowed: true,
        postId: null,
      });

      for (const state of ["draft", "scheduled", "archived"] as const) {
        const { file, post } = await seedPostFile({ purpose, state });
        await expect(canAccessFile(null, file)).resolves.toEqual({
          allowed: false,
          errorCode: "authRequired",
        });
        await expect(canAccessFile(owner, file)).resolves.toEqual({
          allowed: false,
          errorCode: "memberAccessDenied",
        });
        await expect(canAccessFile(admin, file)).resolves.toEqual({
          allowed: true,
          postId: post.id,
        });
      }
    }
  });

  it("enforces visibility and membership state while honoring inactive-tier entitlements", async () => {
    const [loggedIn, lower, exact, higher, suspended, revoked, expired] = await db
      .insert(users)
      .values(
        ["login", "lower", "exact", "higher", "suspended", "revoked", "expired"].map((name) => ({
          email: `${name}-${randomUUID()}@example.test`,
        })),
      )
      .returning();
    const lowerTier = await seedTier(5);
    const requiredTier = await seedTier(10, false);
    const higherTier = await seedTier(20);
    await seedMembership(lower!, lowerTier.id);
    await seedMembership(exact!, requiredTier.id);
    await seedMembership(higher!, higherTier.id);
    await seedMembership(suspended!, requiredTier.id, { status: "suspended" });
    await seedMembership(revoked!, requiredTier.id, { status: "revoked" });
    await seedMembership(expired!, requiredTier.id, {
      endsAt: new Date(Date.now() - 1_000),
    });
    await expect(getActiveMembership(suspended!.id)).resolves.toBeNull();
    await expect(getActiveMembership(revoked!.id)).resolves.toBeNull();
    await expect(getActiveMembership(expired!.id)).resolves.toBeNull();

    for (const purpose of ["content_image", "content_attachment"] as const) {
      const publicContent = await seedPostFile({ purpose, visibility: "public" });
      const loginContent = await seedPostFile({ purpose, visibility: "login" });
      const memberContent = await seedPostFile({
        purpose,
        visibility: "member",
        requiredTierId: requiredTier.id,
      });

      await expect(canAccessPost(null, publicContent.post)).resolves.toBe(true);
      await expect(canAccessFile(null, publicContent.file)).resolves.toMatchObject({
        allowed: true,
      });
      await expect(canAccessPost(null, loginContent.post)).resolves.toBe(false);
      await expect(canAccessFile(null, loginContent.file)).resolves.toEqual({
        allowed: false,
        errorCode: "authRequired",
      });
      await expect(canAccessPost(loggedIn!, loginContent.post)).resolves.toBe(true);
      await expect(canAccessFile(loggedIn!, loginContent.file)).resolves.toMatchObject({
        allowed: true,
      });

      await expect(canAccessPost(null, memberContent.post)).resolves.toBe(false);
      await expect(canAccessFile(null, memberContent.file)).resolves.toEqual({
        allowed: false,
        errorCode: "authRequired",
      });
      for (const user of [loggedIn!, lower!, suspended!, revoked!, expired!]) {
        await expect(canAccessPost(user, memberContent.post)).resolves.toBe(false);
        await expect(canAccessFile(user, memberContent.file)).resolves.toEqual({
          allowed: false,
          errorCode: "memberAccessDenied",
        });
      }
      await expect(canAccessPost(exact!, memberContent.post)).resolves.toBe(true);
      await expect(canAccessFile(exact!, memberContent.file)).resolves.toMatchObject({
        allowed: true,
      });
      await expect(canAccessPost(higher!, memberContent.post)).resolves.toBe(true);
      await expect(canAccessFile(higher!, memberContent.file)).resolves.toMatchObject({
        allowed: true,
      });
    }
  });

  it("keeps draft-only inline images private while administrators retain access", async () => {
    const { admin, other } = await seedUsers();
    const { post, file } = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "public",
    });
    await seedTranslation({ postId: post.id, fileId: file.id, status: "draft" });

    await expect(canAccessFile(null, file)).resolves.toEqual({
      allowed: false,
      errorCode: "authRequired",
    });
    await expect(canAccessFile(other, file)).resolves.toEqual({
      allowed: false,
      errorCode: "memberAccessDenied",
    });
    await expect(canAccessFile(admin, file)).resolves.toEqual({
      allowed: true,
      postId: post.id,
    });

    await expect(authorizeAndPrepareDownload({ user: null, file })).rejects.toMatchObject({
      status: 401,
      code: "authRequired",
    });
    await expect(authorizeAndPrepareDownload({ user: other, file })).rejects.toMatchObject({
      status: 403,
      code: "memberAccessDenied",
    });
    await expect(db.select().from(downloadLogs)).resolves.toEqual([]);
    await expect(db.select().from(appEvents)).resolves.toEqual([]);
    expect(storageMocks.getObject).not.toHaveBeenCalled();
    expect(storageMocks.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("applies draft, published, and archived translation state on the next request", async () => {
    const { post, file } = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "public",
    });
    const translation = await seedTranslation({
      postId: post.id,
      fileId: file.id,
      status: "draft",
    });

    await expect(canAccessFile(null, file)).resolves.toMatchObject({ allowed: false });

    await db
      .update(postTranslations)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(postTranslations.id, translation.id));
    await expect(canAccessFile(null, file)).resolves.toEqual({
      allowed: true,
      postId: post.id,
    });

    await db
      .update(postTranslations)
      .set({ status: "archived", publishedAt: null })
      .where(eq(postTranslations.id, translation.id));
    await expect(canAccessFile(null, file)).resolves.toEqual({
      allowed: false,
      errorCode: "authRequired",
    });
  });

  it("does not authorize an inline reference from a non-published parent post", async () => {
    const linked = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      state: "draft",
      visibility: "public",
    });
    await db
      .update(posts)
      .set({ body: markdownImage(linked.file.id) })
      .where(eq(posts.id, linked.post.id));

    await expect(canAccessFile(null, linked.file)).resolves.toEqual({
      allowed: false,
      errorCode: "authRequired",
    });
  });

  it("allows inline images referenced by published original or published translation bodies", async () => {
    const original = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "public",
    });
    await db
      .update(posts)
      .set({ body: markdownImage(original.file.id) })
      .where(eq(posts.id, original.post.id));
    const [originalPost] = await db.select().from(posts).where(eq(posts.id, original.post.id));
    await expect(canAccessFile(null, original.file)).resolves.toEqual({
      allowed: true,
      postId: originalPost!.id,
    });

    const translated = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "public",
    });
    await seedTranslation({
      postId: translated.post.id,
      fileId: translated.file.id,
      status: "draft",
      locale: "ja",
    });
    await seedTranslation({
      postId: translated.post.id,
      fileId: translated.file.id,
      status: "published",
      locale: "en",
    });
    await expect(canAccessFile(null, translated.file)).resolves.toEqual({
      allowed: true,
      postId: translated.post.id,
    });
  });

  it("keeps public, login, and member visibility checks for published inline references", async () => {
    const { owner, other } = await seedUsers();
    const lowerTier = await seedTier(5);
    const requiredTier = await seedTier(10);
    await seedMembership(owner, requiredTier.id);
    await seedMembership(other, lowerTier.id);

    const publicFile = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "public",
    });
    await seedTranslation({
      postId: publicFile.post.id,
      fileId: publicFile.file.id,
      status: "published",
    });
    await expect(canAccessFile(null, publicFile.file)).resolves.toEqual({
      allowed: true,
      postId: publicFile.post.id,
    });

    const loginFile = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "login",
    });
    await seedTranslation({
      postId: loginFile.post.id,
      fileId: loginFile.file.id,
      status: "published",
    });
    await expect(canAccessFile(null, loginFile.file)).resolves.toEqual({
      allowed: false,
      errorCode: "authRequired",
    });
    await expect(canAccessFile(owner, loginFile.file)).resolves.toEqual({
      allowed: true,
      postId: loginFile.post.id,
    });

    const memberFile = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "member",
      requiredTierId: requiredTier.id,
    });
    await seedTranslation({
      postId: memberFile.post.id,
      fileId: memberFile.file.id,
      status: "published",
    });
    await expect(canAccessFile(other, memberFile.file)).resolves.toEqual({
      allowed: false,
      errorCode: "memberAccessDenied",
    });
    await expect(canAccessFile(owner, memberFile.file)).resolves.toEqual({
      allowed: true,
      postId: memberFile.post.id,
    });
  });

  it("allows a non-inline published link even when another post has only a draft inline reference", async () => {
    const draftInline = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "public",
    });
    await seedTranslation({
      postId: draftInline.post.id,
      fileId: draftInline.file.id,
      status: "draft",
    });

    const [galleryPost] = await db
      .insert(posts)
      .values({
        title: "Published gallery",
        slug: `published-gallery-${randomUUID()}`,
        visibility: "public",
        status: "published",
        publishedAt: new Date(),
      })
      .returning();
    await db.insert(postFiles).values({
      postId: galleryPost!.id,
      fileId: draftInline.file.id,
      kind: "image",
    });

    await expect(canAccessFile(null, draftInline.file)).resolves.toEqual({
      allowed: true,
      postId: galleryPost!.id,
    });
  });

  it("allows any accessible published inline path and returns the granting postId", async () => {
    const file = await seedFile("content_image");
    const requiredTier = await seedTier(10);
    const [memberPost, publicPost] = await db
      .insert(posts)
      .values([
        {
          title: "Restricted reference",
          slug: `restricted-reference-${randomUUID()}`,
          body: markdownImage(file.id),
          visibility: "member" as const,
          requiredTierId: requiredTier.id,
          status: "published" as const,
          publishedAt: new Date(),
        },
        {
          title: "Public reference",
          slug: `public-reference-${randomUUID()}`,
          body: markdownImage(file.id),
          visibility: "public" as const,
          status: "published" as const,
          publishedAt: new Date(),
        },
      ])
      .returning();
    await db.insert(postFiles).values([
      { postId: memberPost!.id, fileId: file.id, kind: "inline" },
      { postId: publicPost!.id, fileId: file.id, kind: "inline" },
    ]);

    await expect(canAccessFile(null, file)).resolves.toEqual({
      allowed: true,
      postId: publicPost!.id,
    });
  });

  it("authorizes inline images only through an exact parsed internal Markdown image path", async () => {
    const linked = await seedPostFile({
      purpose: "content_image",
      kind: "inline",
      visibility: "public",
    });
    const invalidBodies = [
      `plain text ${linked.file.id}`,
      `prefix-${linked.file.id}-suffix`,
      `![external](https://example.com/${linked.file.id})`,
      `![forged](/api/files/${linked.file.id}/download-extra)`,
      `![forged](/api/files/${linked.file.id}0/download)`,
    ];

    for (const body of invalidBodies) {
      await db.update(posts).set({ body }).where(eq(posts.id, linked.post.id));
      await expect(canAccessFile(null, linked.file)).resolves.toEqual({
        allowed: false,
        errorCode: "authRequired",
      });
    }

    await db
      .update(posts)
      .set({ body: markdownImage(linked.file.id) })
      .where(eq(posts.id, linked.post.id));
    await expect(canAccessFile(null, linked.file)).resolves.toEqual({
      allowed: true,
      postId: linked.post.id,
    });
  });

  it("proxies public local video ranges through the application", async () => {
    const { post, file } = await seedPostFile({
      purpose: "content_attachment",
      visibility: "public",
      storageDriver: "local",
      mimeType: "video/mp4",
    });
    const access = await authorizeFileAccess(null, file);
    expect(access).toEqual({ postId: post.id, visibility: "public" });

    const result = await prepareAuthorizedDownload({
      user: null,
      file,
      access,
      range: { start: 100, end: 199 },
      inline: true,
      log: false,
    });

    expect(result.mode).toBe("stream");
    expect(storageMocks.getObject).toHaveBeenCalledWith({
      objectKey: file.objectKey,
      bucket: file.bucket,
      start: 100,
      end: 199,
    });
    expect(storageMocks.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("redirects only public S3 inline video with long TTL, inline disposition, and saved MIME", async () => {
    const { post, file } = await seedPostFile({
      purpose: "content_attachment",
      visibility: "public",
      storageDriver: "s3",
      mimeType: "video/mp4",
    });
    const access = await authorizeFileAccess(null, file);
    expect(access).toEqual({ postId: post.id, visibility: "public" });

    const result = await prepareAuthorizedDownload({
      user: null,
      file,
      access,
      inline: true,
      log: true,
    });

    expect(result).toEqual({ mode: "redirect", url: "https://storage.example/signed" });
    expect(storageMocks.createSignedDownloadUrl).toHaveBeenCalledWith({
      objectKey: file.objectKey,
      bucket: file.bucket,
      expiresInSeconds: 21_600,
      downloadName: file.originalName,
      disposition: "inline",
      contentType: "video/mp4",
    });
    expect(storageMocks.getObject).not.toHaveBeenCalled();
    await expect(db.select().from(downloadLogs)).resolves.toEqual([
      expect.objectContaining({
        userId: null,
        postId: post.id,
        fileId: file.id,
        storageDriver: "s3",
      }),
    ]);
    await expect(db.select().from(appEvents)).resolves.toEqual([
      expect.objectContaining({
        type: "file_downloaded",
        payloadJson: { fileId: file.id, userId: null },
      }),
    ]);
  });

  it("proxies login S3 video and reuses the requested Range without signing", async () => {
    const { owner } = await seedUsers();
    const { post, file } = await seedPostFile({
      purpose: "content_attachment",
      visibility: "login",
      storageDriver: "s3",
      mimeType: "video/webm",
    });
    const access = await authorizeFileAccess(owner, file);
    expect(access).toEqual({ postId: post.id, visibility: "login" });

    const result = await prepareAuthorizedDownload({
      user: owner,
      file,
      access,
      range: { start: 10, end: 20 },
      inline: true,
      log: false,
    });

    expect(result.mode).toBe("stream");
    expect(storageMocks.getObject).toHaveBeenCalledWith({
      objectKey: file.objectKey,
      bucket: file.bucket,
      start: 10,
      end: 20,
    });
    expect(storageMocks.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("proxies admin access to a draft S3 video instead of treating it as public", async () => {
    const { admin } = await seedUsers();
    const { post, file } = await seedPostFile({
      purpose: "content_attachment",
      state: "draft",
      visibility: "public",
      storageDriver: "s3",
      mimeType: "video/quicktime",
    });
    const access = await authorizeFileAccess(admin, file);
    expect(access).toEqual({ postId: post.id, visibility: null });

    const result = await prepareAuthorizedDownload({
      user: admin,
      file,
      access,
      inline: true,
      log: false,
    });

    expect(result.mode).toBe("stream");
    expect(storageMocks.getObject).toHaveBeenCalled();
    expect(storageMocks.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("keeps non-video S3 attachments on the short attachment signed URL path", async () => {
    const { file } = await seedPostFile({
      purpose: "content_attachment",
      visibility: "public",
      storageDriver: "s3",
      mimeType: "application/zip",
    });
    const access = await authorizeFileAccess(null, file);

    await expect(
      prepareAuthorizedDownload({
        user: null,
        file,
        access,
        inline: false,
        log: false,
      }),
    ).resolves.toEqual({ mode: "redirect", url: "https://storage.example/signed" });
    expect(storageMocks.createSignedDownloadUrl).toHaveBeenCalledWith({
      objectKey: file.objectKey,
      bucket: file.bucket,
      expiresInSeconds: 300,
      downloadName: file.originalName,
      disposition: "attachment",
      contentType: "application/zip",
    });
  });

  it("proxies member S3 video for a valid tier and denies a lower tier", async () => {
    const { owner, other } = await seedUsers();
    const lowerTier = await seedTier(5);
    const requiredTier = await seedTier(10);
    await seedMembership(owner, requiredTier.id);
    await seedMembership(other, lowerTier.id);
    const { post, file } = await seedPostFile({
      purpose: "content_attachment",
      visibility: "member",
      requiredTierId: requiredTier.id,
      storageDriver: "s3",
      mimeType: "video/x-m4v",
    });

    const access = await authorizeFileAccess(owner, file);
    expect(access).toEqual({ postId: post.id, visibility: "member" });
    await expect(
      prepareAuthorizedDownload({
        user: owner,
        file,
        access,
        range: { start: 0, end: 8 },
        inline: true,
        log: false,
      }),
    ).resolves.toMatchObject({ mode: "stream" });
    expect(storageMocks.createSignedDownloadUrl).not.toHaveBeenCalled();
    await expect(authorizeFileAccess(other, file)).rejects.toMatchObject({
      status: 403,
      code: "memberAccessDenied",
    });
  });

  it("prefers an accessible public post over a member post for shared public S3 video", async () => {
    const { owner } = await seedUsers();
    const requiredTier = await seedTier(10);
    await seedMembership(owner, requiredTier.id);
    const file = await seedFile("content_attachment", null, "s3", "video/mp4");
    const [memberPost, publicPost] = await db
      .insert(posts)
      .values([
        {
          title: "Member video",
          slug: `member-video-${randomUUID()}`,
          visibility: "member" as const,
          requiredTierId: requiredTier.id,
          status: "published" as const,
          publishedAt: new Date(),
        },
        {
          title: "Public video",
          slug: `public-video-${randomUUID()}`,
          visibility: "public" as const,
          status: "published" as const,
          publishedAt: new Date(),
        },
      ])
      .returning();
    await db.insert(postFiles).values([
      { postId: memberPost!.id, fileId: file.id, kind: "attachment" },
      { postId: publicPost!.id, fileId: file.id, kind: "attachment" },
    ]);

    const access = await authorizeFileAccess(owner, file);
    expect(access).toEqual({ postId: publicPost!.id, visibility: "public" });
    await expect(
      prepareAuthorizedDownload({
        user: owner,
        file,
        access,
        inline: true,
        log: false,
      }),
    ).resolves.toEqual({ mode: "redirect", url: "https://storage.example/signed" });
  });

  it("rechecks member expiry, revocation, tier changes, and post status on each video request", async () => {
    const { owner } = await seedUsers();
    const requiredTier = await seedTier(10);
    const higherTier = await seedTier(20);
    await seedMembership(owner, requiredTier.id);
    const { post, file } = await seedPostFile({
      purpose: "content_attachment",
      visibility: "member",
      requiredTierId: requiredTier.id,
      storageDriver: "s3",
      mimeType: "video/mp4",
    });

    await expect(authorizeFileAccess(owner, file)).resolves.toEqual({
      postId: post.id,
      visibility: "member",
    });

    await db.update(memberships).set({ status: "revoked" }).where(eq(memberships.userId, owner.id));
    await expect(authorizeFileAccess(owner, file)).rejects.toMatchObject({ status: 403 });

    await db
      .update(memberships)
      .set({ status: "active", endsAt: new Date(Date.now() - 1000) })
      .where(eq(memberships.userId, owner.id));
    await expect(authorizeFileAccess(owner, file)).rejects.toMatchObject({ status: 403 });

    await db
      .update(memberships)
      .set({ endsAt: new Date(Date.now() + 86_400_000) })
      .where(eq(memberships.userId, owner.id));
    await db.update(posts).set({ requiredTierId: higherTier.id }).where(eq(posts.id, post.id));
    await expect(authorizeFileAccess(owner, file)).rejects.toMatchObject({ status: 403 });

    await db
      .update(memberships)
      .set({ tierId: higherTier.id })
      .where(eq(memberships.userId, owner.id));
    await expect(authorizeFileAccess(owner, file)).resolves.toMatchObject({
      visibility: "member",
    });

    await db
      .update(posts)
      .set({ status: "archived", publishedAt: null })
      .where(eq(posts.id, post.id));
    await expect(authorizeFileAccess(owner, file)).rejects.toMatchObject({ status: 403 });
  });

  it("does not reuse login authorization after the next request becomes anonymous", async () => {
    const { owner } = await seedUsers();
    const { post, file } = await seedPostFile({
      purpose: "content_attachment",
      visibility: "login",
      storageDriver: "local",
      mimeType: "video/webm",
    });

    await expect(authorizeFileAccess(owner, file)).resolves.toEqual({
      postId: post.id,
      visibility: "login",
    });
    await expect(authorizeFileAccess(null, file)).rejects.toMatchObject({
      status: 401,
      code: "authRequired",
    });
  });

  it("logs initial video requests but not seek or resume ranges", async () => {
    const { post, file } = await seedPostFile({
      purpose: "content_attachment",
      visibility: "public",
      storageDriver: "local",
      mimeType: "video/mp4",
    });
    const access = await authorizeFileAccess(null, file);
    const ranges = [null, { start: 0, end: 4 }, { start: 5, end: 8 }] as const;
    for (const range of ranges) {
      await prepareAuthorizedDownload({
        user: null,
        file,
        access,
        range: range ?? undefined,
        inline: true,
        log: shouldLogInitialFileRequest(file, range),
      });
    }

    await expect(db.select().from(downloadLogs)).resolves.toHaveLength(2);
    await expect(db.select().from(appEvents)).resolves.toHaveLength(2);
    const logs = await db.select().from(downloadLogs);
    expect(logs.every((log) => log.postId === post.id && log.fileId === file.id)).toBe(true);
  });

  it("logs successful downloads and leaves no side effects when authorization fails", async () => {
    const { owner, other } = await seedUsers();
    const { file, post } = await seedPostFile({ visibility: "login" });

    const result = await authorizeAndPrepareDownload({
      user: owner,
      file,
      ip: "192.0.2.10",
      userAgent: "integration-test",
    });
    expect(result.mode).toBe("stream");
    expect(storageMocks.getObject).toHaveBeenCalledWith({
      objectKey: file.objectKey,
      bucket: file.bucket,
    });
    await expect(db.select().from(downloadLogs)).resolves.toEqual([
      expect.objectContaining({
        userId: owner.id,
        postId: post.id,
        fileId: file.id,
        ip: "192.0.2.10",
        userAgent: "integration-test",
        storageDriver: "local",
      }),
    ]);
    await expect(db.select().from(appEvents)).resolves.toEqual([
      expect.objectContaining({
        type: "file_downloaded",
        payloadJson: { fileId: file.id, userId: owner.id },
      }),
    ]);

    const denied = await seedPostFile({
      visibility: "member",
      requiredTierId: (await seedTier(10)).id,
      storageDriver: "s3",
    });
    await expect(
      authorizeAndPrepareDownload({ user: other, file: denied.file }),
    ).rejects.toMatchObject({
      status: 403,
      code: "memberAccessDenied",
    });
    await expect(db.select().from(downloadLogs)).resolves.toHaveLength(1);
    await expect(db.select().from(appEvents)).resolves.toHaveLength(1);
    expect(storageMocks.createSignedDownloadUrl).not.toHaveBeenCalled();
  });
});
