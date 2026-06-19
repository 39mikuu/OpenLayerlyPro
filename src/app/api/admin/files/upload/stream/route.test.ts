import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLimit: vi.fn(),
  parseFileName: vi.fn(),
  requireAdmin: vi.fn(),
  saveStreamedFile: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/file", () => ({
  getContentAttachmentUploadLimit: mocks.getLimit,
  parseStreamFileName: mocks.parseFileName,
  saveStreamedFile: mocks.saveStreamedFile,
}));

import { POST } from "./route";

describe("admin streamed upload API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
    mocks.getLimit.mockResolvedValue({ maxMb: 10, maxBytes: 10 * 1024 * 1024 });
    mocks.parseFileName.mockReturnValue("movie.mp4");
    mocks.saveStreamedFile.mockResolvedValue({ id: "file-1" });
  });

  it("passes the raw request body to the attachment service", async () => {
    let received = Buffer.alloc(0);
    mocks.saveStreamedFile.mockImplementation(async ({ body }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks);
      return { id: "file-1" };
    });

    const response = await POST(
      new NextRequest("http://localhost/api/admin/files/upload/stream", {
        method: "POST",
        headers: {
          "content-type": "video/mp4",
          "x-file-name": encodeURIComponent("movie.mp4"),
          "x-file-purpose": "content_attachment",
        },
        body: Buffer.from("raw-video-body"),
      }),
    );

    expect(response.status).toBe(200);
    expect(received.toString()).toBe("raw-video-body");
    expect(mocks.saveStreamedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "movie.mp4",
        purpose: "content_attachment",
        createdBy: "admin-1",
      }),
    );
  });

  it("quickly rejects a declared Content-Length above the configured limit", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/admin/files/upload/stream", {
        method: "POST",
        headers: {
          "content-length": String(10 * 1024 * 1024 + 1),
          "x-file-name": "archive.zip",
        },
        body: Buffer.from("small-body"),
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.saveStreamedFile).not.toHaveBeenCalled();
  });

  it("rejects any purpose other than content_attachment", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/admin/files/upload/stream", {
        method: "POST",
        headers: {
          "x-file-name": "image.png",
          "x-file-purpose": "content_image",
        },
        body: Buffer.from("image"),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.parseFileName).not.toHaveBeenCalled();
    expect(mocks.saveStreamedFile).not.toHaveBeenCalled();
  });

  it("returns fileRequired when there is no request body", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/admin/files/upload/stream", {
        method: "POST",
        headers: { "x-file-name": "empty.txt" },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.saveStreamedFile).not.toHaveBeenCalled();
  });
});
