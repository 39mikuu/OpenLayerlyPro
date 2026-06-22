import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getEnv } from "@/lib/env";
import { multipartTransferLimitBytes } from "@/lib/request-body";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  saveUploadedFile: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/file", () => ({ saveUploadedFile: mocks.saveUploadedFile }));

import { POST } from "./route";

describe("buffered admin upload API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
  });

  it("returns 413 before auth when the multipart declaration exceeds the cap", async () => {
    const limit = multipartTransferLimitBytes(Math.max(50, getEnv().PAYMENT_PROOF_MAX_SIZE_MB));
    const response = await POST(
      new NextRequest("http://localhost/api/admin/files/upload", {
        method: "POST",
        headers: {
          "content-length": String(limit + 1),
          "content-type": "multipart/form-data; boundary=bounded-test",
        },
        body: "x",
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("rejects content attachments so they cannot fall back to multipart buffering", async () => {
    const form = new FormData();
    form.set("file", new File(["attachment"], "archive.zip", { type: "application/zip" }));
    form.set("purpose", "content_attachment");

    const response = await POST(
      new NextRequest("http://localhost/api/admin/files/upload", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });
});
