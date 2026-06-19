import { randomUUID } from "crypto";
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
      kind: file.purpose === "content_image" ? "image" : "attachment",
    });
    return { post: post!, file };
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
