import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { multipartTransferLimitBytes } from "@/lib/request-body";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  rateLimit: vi.fn(),
  saveUploadedFile: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/file", () => ({ saveUploadedFile: mocks.saveUploadedFile }));

import { POST } from "./route";

function transferLimit(): number {
  return multipartTransferLimitBytes(Math.max(50, getEnv().PAYMENT_PROOF_MAX_SIZE_MB));
}

function unreadRequest(): { request: NextRequest; getReader: ReturnType<typeof vi.fn> } {
  const request = new NextRequest("http://localhost/api/admin/files/upload", {
    method: "POST",
    headers: {
      "content-length": String(transferLimit()),
      "content-type": "multipart/form-data; boundary=bounded-test",
    },
  });
  const getReader = vi.fn();
  Object.defineProperty(request, "body", { value: { getReader } });
  return { request, getReader };
}

describe("buffered admin upload API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
    mocks.rateLimit.mockReturnValue(true);
  });

  it("returns 413 before auth when the multipart declaration exceeds the cap", async () => {
    const limit = transferLimit();
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("does not read an unauthenticated admin request body", async () => {
    const { request, getReader } = unreadRequest();
    mocks.requireAdmin.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("rejects a concurrent admin request at the pre-auth bucket before auth or body reads", async () => {
    let resolveFirstAuth!: (value: { id: string; role: string }) => void;
    mocks.requireAdmin.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstAuth = resolve;
        }),
    );
    mocks.rateLimit.mockReturnValue(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const first = unreadRequest();
    const second = unreadRequest();

    const firstResponsePromise = POST(first.request);
    await vi.waitFor(() => expect(mocks.requireAdmin).toHaveBeenCalledTimes(1));
    const secondResponse = await POST(second.request);

    expect(secondResponse.status).toBe(429);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(first.getReader).not.toHaveBeenCalled();
    expect(second.getReader).not.toHaveBeenCalled();

    resolveFirstAuth({ id: "admin-1", role: "admin" });
    await firstResponsePromise;
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
