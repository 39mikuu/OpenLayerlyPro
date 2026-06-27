import { describe, expect, it } from "vitest";

import { resolveS3SignedDownloadOrigin } from "./s3";

const base = {
  region: "auto",
  bucket: "artist-media",
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
};

describe("S3 signed URL CSP origin", () => {
  it("uses the endpoint origin for path-style MinIO URLs", async () => {
    await expect(
      resolveS3SignedDownloadOrigin({
        ...base,
        endpoint: "https://minio.example",
        forcePathStyle: true,
      }),
    ).resolves.toBe("https://minio.example");
  });

  it("uses the bucket-qualified final host for virtual-hosted URLs", async () => {
    await expect(
      resolveS3SignedDownloadOrigin({
        ...base,
        endpoint: "https://objects.example",
        forcePathStyle: false,
      }),
    ).resolves.toBe("https://artist-media.objects.example");
  });

  it("derives the actual R2-compatible signed host instead of assuming the endpoint", async () => {
    await expect(
      resolveS3SignedDownloadOrigin({
        ...base,
        endpoint: "https://account.r2.cloudflarestorage.com",
        forcePathStyle: false,
      }),
    ).resolves.toBe("https://artist-media.account.r2.cloudflarestorage.com");
  });

  it.each([
    "https://*.objects.example",
    "https://user:secret@objects.example",
    "https://objects.example\nhttps://evil.example",
  ])("rejects unsafe raw endpoint %s before signing", async (endpoint) => {
    await expect(
      resolveS3SignedDownloadOrigin({
        ...base,
        endpoint,
        forcePathStyle: true,
      }),
    ).resolves.toBeNull();
  });
});
