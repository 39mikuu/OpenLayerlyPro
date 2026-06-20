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

import { authorizeAndPrepareDownload, canAccessFile } from "./index";

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
  ): Promise<FileRecord> {
    const [file] = await db
      .insert(files)
      .values({
        storageDriver,
        bucket: storageDriver === "s3" ? "private" : null,
        objectKey: `${purpose}/${randomUUID()}`,
        originalName: `${purpose}.bin`,
        mimeType: "application/octet-stream",
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
    const file = await seedFile(input.purpose ?? "content_attachment", null, input.storageDriver);
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
