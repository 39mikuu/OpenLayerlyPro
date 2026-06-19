import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
