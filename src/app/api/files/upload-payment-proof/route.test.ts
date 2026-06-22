import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { multipartTransferLimitBytes } from "@/lib/request-body";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rateLimit: vi.fn(),
  saveUploadedFile: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/file", () => ({ saveUploadedFile: mocks.saveUploadedFile }));

import { POST } from "./route";

function transferLimit(): number {
  return multipartTransferLimitBytes(getEnv().PAYMENT_PROOF_MAX_SIZE_MB);
}

function streamRequest(chunks: Uint8Array[], headers: HeadersInit = {}): NextRequest {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://localhost/api/files/upload-payment-proof", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=bounded-test",
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" }) as NextRequest;
}

describe("payment proof multipart upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1", role: "fan" });
    mocks.rateLimit.mockReturnValue(true);
    mocks.saveUploadedFile.mockResolvedValue({ id: "file-1", originalName: "proof.png" });
  });

  it("accepts one normal payment screenshot", async () => {
    const form = new FormData();
    form.set("file", new File(["image"], "proof.png", { type: "image/png" }));

    const response = await POST(
      new Request("http://localhost/api/files/upload-payment-proof", {
        method: "POST",
        body: form,
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledOnce();
    expect(mocks.saveUploadedFile).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "payment_proof", createdBy: "user-1" }),
    );
  });

  it("pre-rejects an oversized Content-Length before auth, image handling, storage, or DB", async () => {
    const response = await POST(
      streamRequest([Uint8Array.from([1])], {
        "content-length": String(transferLimit() + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("rejects a chunked body that crosses the actual transfer limit", async () => {
    const limit = transferLimit();
    const response = await POST(streamRequest([new Uint8Array(limit), Uint8Array.from([1])]));

    expect(response.status).toBe(413);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("rejects actual bytes when Content-Length dishonestly reports a smaller body", async () => {
    const limit = transferLimit();
    const response = await POST(
      streamRequest([new Uint8Array(limit), Uint8Array.from([1])], {
        "content-length": "1",
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("counts multipart text fields and protocol overhead in the total transfer ceiling", async () => {
    const form = new FormData();
    form.set("file", new File(["x"], "proof.png", { type: "image/png" }));
    form.set("note", "x".repeat(transferLimit()));

    const response = await POST(
      new Request("http://localhost/api/files/upload-payment-proof", {
        method: "POST",
        body: form,
      }) as NextRequest,
    );

    expect(response.status).toBe(413);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("preserves the existing per-file business size validation below the transfer ceiling", async () => {
    const maxMb = getEnv().PAYMENT_PROOF_MAX_SIZE_MB;
    const fileBytes = maxMb * 1024 * 1024 + 1;
    const form = new FormData();
    form.set("file", new File([new Uint8Array(fileBytes)], "proof.png", { type: "image/png" }));
    mocks.saveUploadedFile.mockRejectedValue(new ApiError(400, "fileTooLarge", { maxMb }));

    const response = await POST(
      new Request("http://localhost/api/files/upload-payment-proof", {
        method: "POST",
        body: form,
      }) as NextRequest,
    );

    expect(response.status).toBe(400);
    expect(mocks.saveUploadedFile).toHaveBeenCalledOnce();
  });

  it("rejects a missing file and multiple files", async () => {
    const missing = new FormData();
    missing.set("note", "no file");
    const missingResponse = await POST(
      new Request("http://localhost/api/files/upload-payment-proof", {
        method: "POST",
        body: missing,
      }) as NextRequest,
    );
    expect(missingResponse.status).toBe(400);
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();

    const multiple = new FormData();
    multiple.append("file", new File(["one"], "one.png", { type: "image/png" }));
    multiple.append("file", new File(["two"], "two.png", { type: "image/png" }));
    const multipleResponse = await POST(
      new Request("http://localhost/api/files/upload-payment-proof", {
        method: "POST",
        body: multiple,
      }) as NextRequest,
    );
    expect(multipleResponse.status).toBe(400);
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });
});
