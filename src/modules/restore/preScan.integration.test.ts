import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storageState = vi.hoisted(() => ({
  existing: new Set<string>(),
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
  };
});

import { getDb } from "@/db";
import { files } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { FILE_SAFETY_REMEDIATION_VERSION } from "@/modules/file/backfillSafety";

import { runRestorePreScan } from "./preScan";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("restore pre-scan integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    storageState.existing.clear();
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
    return file!;
  }

  it("quarantines files whose storage objects are missing", async () => {
    const present = await seedFile(`present/${randomUUID()}.png`);
    const missing = await seedFile(`missing/${randomUUID()}.png`);
    storageState.existing.add(present.objectKey);

    const report = await runRestorePreScan(db);

    expect(report).toMatchObject({
      scanned: 2,
      quarantined: 1,
      errors: [],
    });

    const [missingRow] = await db.select().from(files).where(eq(files.id, missing.id));
    expect(missingRow).toMatchObject({
      quarantineReason: "missing after restore",
      remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
    });
    expect(missingRow?.quarantinedAt).not.toBeNull();

    const [presentRow] = await db.select().from(files).where(eq(files.id, present.id));
    expect(presentRow?.quarantinedAt).toBeNull();
  });
});
