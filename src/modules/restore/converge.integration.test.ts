import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storageState = vi.hoisted(() => ({
  existing: new Map<string, string>(),
  enumerated: [] as string[],
}));

vi.mock("@/modules/restore/storageProbe", async () => {
  const actual = await vi.importActual<typeof import("./storageProbe")>(
    "@/modules/restore/storageProbe",
  );
  return {
    ...actual,
    objectExists: vi.fn(async ({ objectKey }: { objectKey: string }) =>
      storageState.existing.has(objectKey),
    ),
    enumerateStorageObjects: vi.fn(async () => ({
      objectKeys: storageState.enumerated,
      bucket: null,
      truncated: false,
    })),
  };
});

import { getDb } from "@/db";
import { files, postFiles, posts, tasks } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { authorizeFileAccess } from "@/modules/download";
import { FILE_SAFETY_REMEDIATION_VERSION } from "@/modules/file/backfillSafety";
import { createStorageDeleteDedupeKeyForTests } from "@/modules/file/cleanup";

import { RestoreConvergeError, runRestoreConverge } from "./converge";
import { neutralizeRestoredTasks } from "./neutralize";
import * as storageProbe from "./storageProbe";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("restore converge integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    storageState.existing.clear();
    storageState.enumerated = [];
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seedFile(objectKey: string) {
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        bucket: null,
        objectKey,
        originalName: `${objectKey}.png`,
        mimeType: "image/png",
        sizeBytes: 128,
        purpose: "content_image",
      })
      .returning();
    storageState.existing.set(objectKey, file!.id);
    return file!;
  }

  it("quarantines missing referenced objects and enqueues orphan deletions", async () => {
    const referenced = await seedFile(`referenced/${randomUUID()}.png`);
    const missing = await seedFile(`missing/${randomUUID()}.png`);
    storageState.existing.delete(missing.objectKey);
    const orphanKey = `orphan/${randomUUID()}.png`;
    storageState.enumerated = [referenced.objectKey, orphanKey];

    const report = await runRestoreConverge(db);

    expect(report.totalMissingReferenced).toBe(1);
    expect(report.totalNewlyQuarantined).toBe(1);
    expect(report.totalOrphanObjects).toBe(1);
    expect(report.totalOrphanDeletesEnqueued).toBe(1);

    const [missingRow] = await db.select().from(files).where(eq(files.id, missing.id));
    expect(missingRow).toMatchObject({
      quarantineReason: "missing after restore",
      remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
    });

    const deletePayload = {
      storageDriver: "local" as const,
      bucket: null,
      objectKey: orphanKey,
    };
    const [deleteTask] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, "storage.delete_object"),
          eq(tasks.dedupeKey, createStorageDeleteDedupeKeyForTests(deletePayload)),
        ),
      );
    expect(deleteTask).toBeDefined();
    expect(deleteTask?.payloadJson).toEqual(deletePayload);
  });

  it("fails when storage enumeration is truncated before completion", async () => {
    await seedFile(`referenced/${randomUUID()}.png`);
    storageState.enumerated = [];
    vi.mocked(storageProbe.enumerateStorageObjects).mockResolvedValueOnce({
      objectKeys: [],
      bucket: null,
      truncated: true,
    });

    await expect(runRestoreConverge(db)).rejects.toBeInstanceOf(RestoreConvergeError);
  });

  it("enqueues orphan cleanup after terminal storage.delete_object rows were neutralized", async () => {
    const deletePayload = {
      storageDriver: "local" as const,
      bucket: null,
      objectKey: `orphan/${randomUUID()}.png`,
    };
    const dedupeKey = createStorageDeleteDedupeKeyForTests(deletePayload);

    await db.insert(tasks).values({
      kind: "storage.delete_object",
      dedupeKey,
      payloadJson: deletePayload,
      status: "succeeded",
    });
    await neutralizeRestoredTasks(db);
    storageState.enumerated = [deletePayload.objectKey];

    const report = await runRestoreConverge(db);

    expect(report.totalOrphanObjects).toBe(1);
    expect(report.totalOrphanDeletesEnqueued).toBe(1);
    const [deleteTask] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, "storage.delete_object"),
          eq(tasks.dedupeKey, dedupeKey),
          eq(tasks.status, "pending"),
        ),
      );
    expect(deleteTask).toBeDefined();
  });

  it("returns 410 for authorized access after missing-after-restore quarantine", async () => {
    const [post] = await db
      .insert(posts)
      .values({
        title: "restore converge quarantine",
        slug: `restore-converge-${randomUUID()}`,
        status: "published",
        visibility: "public",
        publishedAt: new Date(),
      })
      .returning();
    const missing = await seedFile(`missing/${randomUUID()}.png`);
    await db.insert(postFiles).values({
      postId: post!.id,
      fileId: missing.id,
      kind: "image",
    });
    storageState.existing.delete(missing.objectKey);
    storageState.enumerated = [];

    await runRestoreConverge(db);

    const [quarantined] = await db.select().from(files).where(eq(files.id, missing.id));
    await expect(authorizeFileAccess(null, quarantined!)).rejects.toMatchObject({
      status: 410,
      code: "fileQuarantined",
    });
  });
});
