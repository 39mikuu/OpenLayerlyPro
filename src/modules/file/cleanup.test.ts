import { describe, expect, it } from "vitest";

import { createStorageDeleteDedupeKeyForTests } from "./cleanup";

describe("storage.delete_object dedupe keys", () => {
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
});
