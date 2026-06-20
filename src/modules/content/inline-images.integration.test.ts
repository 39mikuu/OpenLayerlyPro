import { randomUUID } from "crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  putObject: vi.fn(),
}));

vi.mock("@/modules/storage", () => ({
  getStorage: vi.fn(async () => ({
    driver: "local" as const,
    putObject: storageMocks.putObject,
    getObject: vi.fn(),
    deleteObject: storageMocks.deleteObject,
  })),
  getStorageForDriver: vi.fn(async () => ({
    driver: "local" as const,
    putObject: storageMocks.putObject,
    getObject: vi.fn(),
    deleteObject: storageMocks.deleteObject,
  })),
}));

import { getDb } from "@/db";
import { files, postFiles, posts, postTranslations, tasks } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import {
  attachFileToPost,
  createPost,
  deleteDraftTranslation,
  deletePost,
  deleteTranslation,
  detachFileFromPost,
  publishTranslation,
  savePostContent,
  updatePost,
  upsertDraftTranslation,
} from "@/modules/content";
import { saveUploadedFile } from "@/modules/file";
import { cleanupOrphanFile } from "@/modules/file/cleanup";
import { runTaskHandler } from "@/modules/tasks/handlers";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n5sAAAAASUVORK5CYII=",
  "base64",
);

function markdownImage(fileId: string): string {
  return `![inline](/api/files/${fileId}/download)`;
}

describeWithDatabase("Markdown inline image lifecycle integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    vi.clearAllMocks();
    storageMocks.putObject.mockImplementation(async (input: { objectKey: string }) => ({
      objectKey: input.objectKey,
      bucket: null,
    }));
    storageMocks.deleteObject.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await db.execute(sql.raw("drop trigger if exists test_fail_inline_cleanup_task on tasks"));
    await db.execute(sql.raw("drop trigger if exists test_fail_storage_delete_task on tasks"));
    await db.execute(sql.raw("drop function if exists test_fail_inline_cleanup_task()"));
    await db.execute(sql.raw("drop function if exists test_fail_storage_delete_task()"));
    await resetDatabase(db);
  });

  async function uploadInline(name = "inline.png") {
    return saveUploadedFile({
      file: new File([PNG], name, { type: "image/png" }),
      purpose: "content_image",
    });
  }

  async function seedFile(purpose: "content_image" | "content_attachment" = "content_image") {
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        bucket: null,
        objectKey: `content/${randomUUID()}`,
        originalName: `${purpose}.bin`,
        mimeType: purpose === "content_image" ? "image/png" : "application/octet-stream",
        sizeBytes: 10,
        purpose,
      })
      .returning();
    return file!;
  }

  async function cleanupTasks(fileId?: string) {
    const rows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "file.cleanup_orphan"))
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    if (!fileId) return rows;
    return rows.filter(
      (task) => (task.payloadJson as { fileId?: string } | null)?.fileId === fileId,
    );
  }

  async function storageDeleteTasks() {
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "storage.delete_object"))
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
  }

  async function links(postId: string) {
    return db
      .select()
      .from(postFiles)
      .where(and(eq(postFiles.postId, postId), eq(postFiles.kind, "inline")));
  }

  it("uploads unlinked images with a delayed durable cleanup task", async () => {
    const before = Date.now();
    const file = await uploadInline();
    const [task] = await cleanupTasks(file.id);

    expect(task).toBeDefined();
    expect(task!.dedupeKey).toBeNull();
    expect(task!.payloadJson).toEqual({ fileId: file.id });
    expect(task!.runAfter.getTime()).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000);
    expect(await links(randomUUID())).toEqual([]);
  });

  it("compensates the stored object when the cleanup task cannot be enqueued", async () => {
    await db.execute(
      sql.raw(`
      create or replace function test_fail_inline_cleanup_task() returns trigger as $$
      begin
        if new.kind = 'file.cleanup_orphan' then
          raise exception 'forced cleanup enqueue failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `),
    );
    await db.execute(
      sql.raw(`
      create trigger test_fail_inline_cleanup_task
      before insert on tasks
      for each row execute function test_fail_inline_cleanup_task()
    `),
    );

    try {
      await expect(uploadInline("compensated.png")).rejects.toThrow();
      expect(storageMocks.deleteObject).toHaveBeenCalledTimes(1);
      await expect(db.select().from(files)).resolves.toEqual([]);
      await expect(cleanupTasks()).resolves.toEqual([]);
    } finally {
      await db.execute(sql.raw("drop trigger test_fail_inline_cleanup_task on tasks"));
      await db.execute(sql.raw("drop function test_fail_inline_cleanup_task()"));
    }
  });

  it("reclaims an unsaved upload after the grace task and treats missing objects as success", async () => {
    const file = await uploadInline("orphan.png");
    const [cleanupTask] = await cleanupTasks(file.id);
    expect(cleanupTask).toBeDefined();

    await expect(runTaskHandler(cleanupTask!)).resolves.toMatchObject({
      note: expect.stringContaining("deleted"),
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toEqual([]);

    const [deleteTask] = await storageDeleteTasks();
    expect(deleteTask).toBeDefined();
    storageMocks.deleteObject.mockResolvedValueOnce(undefined);
    await expect(runTaskHandler(deleteTask!)).resolves.toEqual({});
    expect(storageMocks.deleteObject).toHaveBeenCalledWith({
      objectKey: file.objectKey,
      bucket: file.bucket,
    });
  });

  it("creates an inline link atomically and a delayed cleanup becomes a no-op", async () => {
    const file = await uploadInline("linked.png");
    const post = await createPost({
      title: "Linked",
      slug: `linked-${randomUUID()}`,
      body: markdownImage(file.id),
      visibility: "public",
    });

    await expect(links(post.id)).resolves.toHaveLength(1);
    const [cleanupTask] = await cleanupTasks(file.id);
    await expect(runTaskHandler(cleanupTask!)).resolves.toMatchObject({
      note: expect.stringContaining("referenced"),
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
    await expect(storageDeleteTasks()).resolves.toEqual([]);
  });

  it("can enqueue a new cleanup after an earlier no-op because cleanup keys are event-scoped", async () => {
    const file = await uploadInline("reattempt.png");
    const post = await createPost({
      title: "Reattempt",
      slug: `reattempt-${randomUUID()}`,
      body: markdownImage(file.id),
      visibility: "public",
    });
    const [uploadCleanup] = await cleanupTasks(file.id);
    await runTaskHandler(uploadCleanup!);

    await updatePost(post.id, { body: null });
    const allCleanup = await cleanupTasks(file.id);
    expect(allCleanup).toHaveLength(2);
    expect(allCleanup.every((task) => task.dedupeKey === null)).toBe(true);

    const detachCleanup = allCleanup[1]!;
    await expect(runTaskHandler(detachCleanup)).resolves.toMatchObject({
      note: expect.stringContaining("deleted"),
    });
  });

  it("rolls the post body and links back together when inline validation fails", async () => {
    const valid = await seedFile("content_image");
    const wrongPurpose = await seedFile("content_attachment");
    const post = await createPost({
      title: "Atomic",
      slug: `atomic-${randomUUID()}`,
      body: null,
      visibility: "public",
    });

    await expect(
      updatePost(post.id, {
        body: `${markdownImage(valid.id)}\n${markdownImage(wrongPurpose.id)}`,
      }),
    ).rejects.toMatchObject({ status: 400, code: "postFilePurposeMismatch" });

    const [storedPost] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(storedPost!.body).toBeNull();
    await expect(links(post.id)).resolves.toEqual([]);
  });

  it("retains a link while any locale references it and cleans it after the last locale is removed", async () => {
    const file = await seedFile();
    const post = await createPost({
      title: "Locales",
      slug: `locales-${randomUUID()}`,
      body: markdownImage(file.id),
      visibility: "public",
    });
    await upsertDraftTranslation(post.id, "ja", {
      title: "翻訳",
      body: markdownImage(file.id),
    });

    await updatePost(post.id, { body: null });
    await expect(links(post.id)).resolves.toHaveLength(1);

    await deleteDraftTranslation(post.id, "ja");
    await expect(links(post.id)).resolves.toEqual([]);
    const cleanup = await cleanupTasks(file.id);
    expect(cleanup.length).toBeGreaterThanOrEqual(1);
  });

  it("reconciles links when a published translation is explicitly deleted", async () => {
    const file = await seedFile();
    const post = await createPost({
      title: "Published translation",
      slug: `published-translation-${randomUUID()}`,
      body: null,
      visibility: "public",
    });
    await upsertDraftTranslation(post.id, "ja", {
      title: "公開翻訳",
      body: markdownImage(file.id),
    });
    const published = await publishTranslation(post.id, "ja");
    await expect(links(post.id)).resolves.toHaveLength(1);

    await deleteTranslation(published.id);
    await expect(links(post.id)).resolves.toEqual([]);
    await expect(
      db.select().from(postTranslations).where(eq(postTranslations.id, published.id)),
    ).resolves.toEqual([]);
  });

  it("captures inline ids before post deletion and schedules object cleanup", async () => {
    const file = await seedFile();
    const post = await createPost({
      title: "Delete post",
      slug: `delete-${randomUUID()}`,
      body: markdownImage(file.id),
      visibility: "public",
    });

    await deletePost(post.id);
    await expect(db.select().from(posts).where(eq(posts.id, post.id))).resolves.toEqual([]);
    await expect(links(post.id)).resolves.toEqual([]);
    const cleanup = await cleanupTasks(file.id);
    expect(cleanup).toHaveLength(1);
  });

  it("does not delete a shared file until the final post reference is detached", async () => {
    const file = await seedFile();
    const first = await createPost({
      title: "First",
      slug: `first-${randomUUID()}`,
      body: markdownImage(file.id),
      visibility: "public",
    });
    const second = await createPost({
      title: "Second",
      slug: `second-${randomUUID()}`,
      body: markdownImage(file.id),
      visibility: "public",
    });

    await updatePost(first.id, { body: null });
    const [firstCleanup] = await cleanupTasks(file.id);
    await expect(runTaskHandler(firstCleanup!)).resolves.toMatchObject({
      note: expect.stringContaining("referenced"),
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);

    await updatePost(second.id, { body: null });
    const cleanup = await cleanupTasks(file.id);
    await expect(runTaskHandler(cleanup.at(-1)!)).resolves.toMatchObject({
      note: expect.stringContaining("deleted"),
    });
  });

  it("serializes concurrent cleanup so only one transaction deletes the file", async () => {
    const file = await seedFile();
    const outcomes = await Promise.all([cleanupOrphanFile(file.id), cleanupOrphanFile(file.id)]);

    expect(outcomes.sort()).toEqual(["deleted", "missing"]);
    await expect(storageDeleteTasks()).resolves.toHaveLength(1);
  });

  it("rolls back phase one when the immutable object-delete task cannot be persisted", async () => {
    const file = await seedFile();
    await db.execute(
      sql.raw(`
      create or replace function test_fail_storage_delete_task() returns trigger as $$
      begin
        if new.kind = 'storage.delete_object' then
          raise exception 'forced object task failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `),
    );
    await db.execute(
      sql.raw(`
      create trigger test_fail_storage_delete_task
      before insert on tasks
      for each row execute function test_fail_storage_delete_task()
    `),
    );

    try {
      await expect(cleanupOrphanFile(file.id)).rejects.toThrow();
      await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
      await expect(storageDeleteTasks()).resolves.toEqual([]);
    } finally {
      await db.execute(sql.raw("drop trigger test_fail_storage_delete_task on tasks"));
      await db.execute(sql.raw("drop function test_fail_storage_delete_task()"));
    }
  });

  it("keeps published inline synchronization internal while generic file APIs remain draft-only", async () => {
    const inlineFile = await seedFile();
    const galleryFile = await seedFile();
    const [post] = await db
      .insert(posts)
      .values({
        title: "Published",
        slug: `published-${randomUUID()}`,
        body: null,
        visibility: "public",
        status: "published",
        publishedAt: new Date(),
      })
      .returning();

    await savePostContent(post!.id, { body: markdownImage(inlineFile.id) });
    await expect(links(post!.id)).resolves.toHaveLength(1);

    await expect(
      attachFileToPost({ postId: post!.id, fileId: galleryFile.id, kind: "image" }),
    ).rejects.toMatchObject({ status: 409, code: "postNotEditable" });
    await expect(detachFileFromPost(post!.id, inlineFile.id)).rejects.toMatchObject({
      status: 409,
      code: "postNotEditable",
    });
    await expect(links(post!.id)).resolves.toHaveLength(1);
  });

  it("rejects inline through the generic attach API even if runtime input bypasses TypeScript", async () => {
    const file = await seedFile();
    const post = await createPost({
      title: "Inline attach guard",
      slug: `inline-attach-${randomUUID()}`,
      body: null,
      visibility: "public",
    });

    await expect(
      attachFileToPost({ postId: post.id, fileId: file.id, kind: "inline" } as never),
    ).rejects.toMatchObject({ status: 400, code: "inlineFileManagedByBody" });
    await expect(links(post.id)).resolves.toEqual([]);
  });

  it("rejects generic kind-purpose mismatches on the server", async () => {
    const attachment = await seedFile("content_attachment");
    const post = await createPost({
      title: "Mismatch",
      slug: `mismatch-${randomUUID()}`,
      body: null,
      visibility: "public",
    });

    await expect(
      attachFileToPost({ postId: post.id, fileId: attachment.id, kind: "image" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "postFilePurposeMismatch",
    } satisfies Partial<ApiError>);
  });

  it("lets a temporary phase-two failure retry without recreating a file row", async () => {
    const file = await seedFile();
    await cleanupOrphanFile(file.id);
    const [deleteTask] = await storageDeleteTasks();
    storageMocks.deleteObject.mockRejectedValueOnce(new Error("temporary outage"));

    await expect(runTaskHandler(deleteTask!)).rejects.toThrow("temporary outage");
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toEqual([]);

    storageMocks.deleteObject.mockResolvedValueOnce(undefined);
    await expect(runTaskHandler(deleteTask!)).resolves.toEqual({});
  });
});
