import { describe, expect, it } from "vitest";

import { normalizeStorageBucket, storageObjectIdentity } from "./storageProbe";

const storageConfig = {
  driver: "s3" as const,
  endpoint: "https://s3.example.com",
  region: "auto",
  bucket: "prod-bucket",
  accessKeyId: "access",
  secretAccessKey: "secret",
  forcePathStyle: true,
  s3Configured: true,
};

describe("storage object identity normalization", () => {
  it("treats null S3 bucket rows as the configured bucket for identity", () => {
    const objectKey = "content/2026/06/file.png";
    expect(storageObjectIdentity("s3", null, objectKey, storageConfig)).toBe(
      storageObjectIdentity("s3", "prod-bucket", objectKey, storageConfig),
    );
  });

  it("keeps explicit historical S3 buckets distinct from the configured bucket", () => {
    const objectKey = "content/legacy.png";
    expect(storageObjectIdentity("s3", "historical-bucket", objectKey, storageConfig)).not.toBe(
      storageObjectIdentity("s3", null, objectKey, storageConfig),
    );
  });

  it("normalizes local rows to a null bucket regardless of stored bucket", () => {
    expect(normalizeStorageBucket({ driver: "local", bucket: "stale", storageConfig })).toBeNull();
  });
});
