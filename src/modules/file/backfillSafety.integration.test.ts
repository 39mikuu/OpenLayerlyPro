import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { Readable } from "stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storageState = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  putObject: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const uploadConfigState = vi.hoisted(() => ({ paymentProofMaxSizeMb: 10 }));

vi.mock("@/modules/config", () => ({
  getUploadConfig: vi.fn(async () => ({
    maxUploadSizeMb: 500,
    paymentProofMaxSizeMb: uploadConfigState.paymentProofMaxSizeMb,
  })),
}));

vi.mock("@/modules/storage", () => ({
  getStorageForDriver: vi.fn(async (driver: "local" | "s3") => ({
    driver,
    putObject: storageState.putObject,
    putObjectStream: vi.fn(),
    getObject: storageState.getObject,
    deleteObject: storageState.deleteObject,
  })),
}));

import { getDb } from "@/db";
import { appEvents, files, tasks } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import { FILE_SAFETY_REMEDIATION_VERSION, runFileSafetyBackfill } from "./backfillSafety";
import { normalizeRasterImage } from "./normalizeRasterImage";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("file safety backfill integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    vi.clearAllMocks();
    storageState.objects.clear();
    uploadConfigState.paymentProofMaxSizeMb = 10;
    storageState.getObject.mockImplementation(async ({ objectKey }: { objectKey: string }) => {
      const body = storageState.objects.get(objectKey);
      if (!body) throw new Error(`missing test object: ${objectKey}`);
      return Readable.from([body]);
    });
    storageState.putObject.mockImplementation(
      async ({ objectKey, body }: { objectKey: string; body: Buffer }) => {
        storageState.objects.set(objectKey, Buffer.from(body));
        return { objectKey, bucket: null };
      },
    );
    storageState.deleteObject.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seedFile(input: {
    body: Buffer;
    purpose?: "content_image" | "payment_proof";
    mimeType?: string;
    objectKey?: string;
  }) {
    const objectKey = input.objectKey ?? `legacy/${randomUUID()}.png`;
    storageState.objects.set(objectKey, input.body);
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        bucket: null,
        objectKey,
        originalName: "legacy.png",
        mimeType: input.mimeType ?? "text/html",
        sizeBytes: input.body.length,
        purpose: input.purpose ?? "content_image",
      })
      .returning();
    return file!;
  }

  it("dry-runs without writes, then atomically switches metadata and queues the old key", async () => {
    const clean = await sharp({
      create: { width: 3, height: 2, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const legacy = Buffer.concat([clean, Buffer.from("<script>legacy()</script>")]);
    const file = await seedFile({ body: legacy, objectKey: "legacy/polyglot.png" });

    const dryRun = await runFileSafetyBackfill();
    expect(dryRun).toMatchObject({ dryRun: true, scanned: 1, remediated: 1, quarantined: 0 });
    expect(storageState.putObject).not.toHaveBeenCalled();
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toEqual([
      expect.objectContaining({ objectKey: "legacy/polyglot.png", remediationVersion: 0 }),
    ]);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);

    const applied = await runFileSafetyBackfill({ apply: true });
    expect(applied).toMatchObject({ dryRun: false, scanned: 1, remediated: 1, quarantined: 0 });

    const [updated] = await db.select().from(files).where(eq(files.id, file.id));
    expect(updated).toMatchObject({
      objectKey: `remediated/v${FILE_SAFETY_REMEDIATION_VERSION}/${file.id}.jpg`,
      mimeType: "image/jpeg",
      width: 3,
      height: 2,
      remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
      quarantinedAt: null,
      quarantineReason: null,
    });
    const normalized = await normalizeRasterImage(legacy, "content_image");
    expect(updated!.sha256).toBe(normalized.sha256);
    expect(updated!.sizeBytes).toBe(normalized.sizeBytes);
    expect(storageState.objects.get(updated!.objectKey)).toEqual(normalized.outputBuffer);

    const queued = await db.select().from(tasks);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "storage.delete_object",
      payloadJson: {
        storageDriver: "local",
        bucket: null,
        objectKey: "legacy/polyglot.png",
      },
    });
    expect(storageState.objects.has("legacy/polyglot.png")).toBe(true);
    await expect(db.select().from(appEvents)).resolves.toEqual([
      expect.objectContaining({ type: "file_safety_remediated" }),
    ]);

    const putCalls = storageState.putObject.mock.calls.length;
    await expect(runFileSafetyBackfill({ apply: true })).resolves.toMatchObject({ scanned: 0 });
    expect(storageState.putObject).toHaveBeenCalledTimes(putCalls);
    await expect(db.select().from(tasks)).resolves.toHaveLength(1);
  });

  it("quarantines legacy SVG without rewriting or deleting its original object", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    const file = await seedFile({ body: svg, objectKey: "legacy/evil.png" });

    await expect(runFileSafetyBackfill({ apply: true })).resolves.toMatchObject({
      scanned: 1,
      remediated: 0,
      quarantined: 1,
    });

    const [updated] = await db.select().from(files).where(eq(files.id, file.id));
    expect(updated).toMatchObject({
      objectKey: "legacy/evil.png",
      quarantineReason: "unsupported-format:svg",
      remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
    });
    expect(updated!.quarantinedAt).toBeInstanceOf(Date);
    expect(storageState.putObject).not.toHaveBeenCalled();
    expect(storageState.deleteObject).not.toHaveBeenCalled();
    expect(storageState.objects.get("legacy/evil.png")).toEqual(svg);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
    await expect(db.select().from(appEvents)).resolves.toEqual([
      expect.objectContaining({ type: "file_safety_quarantined" }),
    ]);
  });

  it("retains an oversized remediated legacy image and records an audit warning", async () => {
    uploadConfigState.paymentProofMaxSizeMb = 0.000001;
    const input = await sharp({
      create: { width: 32, height: 32, channels: 4, background: "blue" },
    })
      .png()
      .toBuffer();
    const file = await seedFile({ body: input, purpose: "payment_proof" });

    await expect(runFileSafetyBackfill({ apply: true })).resolves.toMatchObject({
      scanned: 1,
      remediated: 1,
      quarantined: 0,
      oversize: 1,
    });

    const [updated] = await db.select().from(files).where(eq(files.id, file.id));
    expect(updated!.quarantinedAt).toBeNull();
    expect(updated!.remediationVersion).toBe(FILE_SAFETY_REMEDIATION_VERSION);
    await expect(db.select().from(appEvents)).resolves.toEqual([
      expect.objectContaining({ type: "file_safety_remediated_oversize" }),
    ]);
  });
});
