import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  getStorageForDriver: vi.fn(),
}));

vi.mock("@/modules/storage", () => ({
  getStorageForDriver: mocks.getStorageForDriver,
}));

import { createStorageDeleteDedupeKeyForTests, deleteStorageObject } from "./cleanup";

describe("storage.delete_object dedupe keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStorageForDriver.mockResolvedValue({ deleteObject: mocks.deleteObject });
    mocks.deleteObject.mockResolvedValue(undefined);
  });

  it("uses a stable bounded hash of the full storage identity", () => {
    const payload = {
      storageDriver: "s3" as const,
      bucket: "private",
      objectKey: `content/${"very-long/".repeat(100)}image.png`,
    };

    const first = createStorageDeleteDedupeKeyForTests(payload);
    const second = createStorageDeleteDedupeKeyForTests(payload);

    expect(first).toBe(second);
    expect(first).toMatch(/^storage:delete_object:[0-9a-f]{64}$/);
    expect(first).not.toContain(payload.objectKey);
  });

  it("distinguishes driver, bucket, and object key boundaries", () => {
    const base = {
      storageDriver: "s3" as const,
      bucket: "ab",
      objectKey: "c",
    };
    const keys = new Set([
      createStorageDeleteDedupeKeyForTests(base),
      createStorageDeleteDedupeKeyForTests({ ...base, bucket: "a", objectKey: "bc" }),
      createStorageDeleteDedupeKeyForTests({ ...base, storageDriver: "local", bucket: null }),
      createStorageDeleteDedupeKeyForTests({ ...base, objectKey: "different" }),
    ]);

    expect(keys.size).toBe(4);
  });

  it("revalidates task ownership after asynchronous config resolution", async () => {
    const ownershipLost = new Error("task ownership lost");
    const assertOwnership = vi.fn().mockRejectedValue(ownershipLost);
    let finishConfigResolution!: () => void;
    let markConfigStarted!: () => void;
    const configStarted = new Promise<void>((resolve) => {
      markConfigStarted = resolve;
    });
    const configBlocked = new Promise<void>((resolve) => {
      finishConfigResolution = resolve;
    });
    mocks.getStorageForDriver.mockImplementationOnce(async () => {
      markConfigStarted();
      await configBlocked;
      return { deleteObject: mocks.deleteObject };
    });
    const payload = {
      storageDriver: "s3" as const,
      bucket: "private",
      objectKey: "content/2026/08/image.png",
    };

    const deletion = deleteStorageObject(payload, { assertOwnership });
    await configStarted;
    expect(assertOwnership).not.toHaveBeenCalled();
    finishConfigResolution();
    await expect(deletion).rejects.toBe(ownershipLost);

    expect(mocks.getStorageForDriver).toHaveBeenCalledWith("s3");
    expect(assertOwnership).toHaveBeenCalledOnce();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });
});
