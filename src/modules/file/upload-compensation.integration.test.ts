import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  loggerError: vi.fn(),
  putObject: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ logger: { error: mocks.loggerError } }));
vi.mock("@/modules/storage", () => ({
  getStorage: vi.fn(async () => ({
    driver: "s3" as const,
    putObject: mocks.putObject,
    putObjectStream: vi.fn(),
    getObject: vi.fn(),
    deleteObject: mocks.deleteObject,
  })),
  getStorageForDriver: vi.fn(),
}));

import { getDb } from "@/db";
import { files } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import { saveUploadedFile } from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("upload compensation integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    vi.clearAllMocks();
    mocks.putObject.mockImplementation(async ({ objectKey }: { objectKey: string }) => ({
      objectKey,
      bucket: "test-bucket",
    }));
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  it("preserves a real PostgreSQL transaction failure when storage cleanup also fails", async () => {
    const png = await (
      await import("sharp")
    )
      .default({ create: { width: 1, height: 1, channels: 4, background: "white" } })
      .png()
      .toBuffer();
    const file = new File([new Uint8Array(png)], "proof.png", { type: "image/png" });
    mocks.deleteObject.mockRejectedValue(
      Object.assign(new Error("provider delete failed"), { code: "AccessDenied" }),
    );

    let thrown: unknown;
    try {
      await saveUploadedFile({
        file,
        purpose: "payment_proof",
        finalizeInTransaction: async (tx) => {
          // Force a real PostgreSQL failure after INSERT; the whole file transaction must roll back.
          await tx.execute(sql`select 1 / 0`);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "22012" });
    await expect(db.select().from(files)).resolves.toHaveLength(0);
    expect(mocks.deleteObject).toHaveBeenCalledOnce();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Compensation step failed",
      expect.objectContaining({
        storageDriver: "s3",
        objectRef: expect.stringMatching(/^[a-f0-9]{64}$/),
        operation: "storage.delete_object",
        primaryError: { name: "PostgresError", identifier: "22012" },
        cleanupError: { name: "Error", identifier: "AccessDenied" },
      }),
    );
    expect(mocks.loggerError.mock.calls[0]?.[1]).not.toHaveProperty("objectKey");
  });
});
