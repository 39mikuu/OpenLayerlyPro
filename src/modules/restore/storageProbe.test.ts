import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enumerateS3ObjectsUnderPrefixes } from "./storageProbe";

const state = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: vi.fn(
      class MockS3Client {
        send = state.sendMock;
      },
    ),
  };
});

const storageConfig = {
  driver: "s3" as const,
  endpoint: "https://s3.example.com",
  region: "auto",
  bucket: "test-bucket",
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
  forcePathStyle: true,
  s3Configured: true,
};

describe("enumerateS3ObjectsUnderPrefixes", () => {
  afterEach(() => {
    state.sendMock.mockReset();
  });

  it("enumerates only configured application namespaces", async () => {
    state.sendMock.mockImplementation(async (command: ListObjectsV2Command) => {
      const prefix = command.input.Prefix;
      if (prefix === "content/") {
        return { Contents: [{ Key: "content/2026/06/file.png" }], IsTruncated: false };
      }
      if (prefix === "legacy/") {
        return { Contents: [{ Key: "legacy/old.png" }], IsTruncated: false };
      }
      return { Contents: [], IsTruncated: false };
    });

    const result = await enumerateS3ObjectsUnderPrefixes({
      storageConfig,
      prefixes: ["content/", "legacy/"],
      pageSize: 100,
      maxObjects: 100,
    });

    expect(result.objectKeys).toEqual(["content/2026/06/file.png", "legacy/old.png"]);
    expect(result.truncated).toBe(false);
    expect(state.sendMock).toHaveBeenCalledTimes(2);
    expect(S3Client).toHaveBeenCalled();
  });

  it("marks enumeration truncated when the global object budget is exceeded", async () => {
    state.sendMock.mockImplementation(async (command: ListObjectsV2Command) => {
      const prefix = command.input.Prefix;
      if (prefix === "content/") {
        return {
          Contents: [{ Key: "content/a.png" }, { Key: "content/b.png" }],
          IsTruncated: false,
        };
      }
      return { Contents: [{ Key: "legacy/c.png" }], IsTruncated: false };
    });

    const result = await enumerateS3ObjectsUnderPrefixes({
      storageConfig,
      prefixes: ["content/", "legacy/"],
      pageSize: 100,
      maxObjects: 2,
    });

    expect(result.objectKeys).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
