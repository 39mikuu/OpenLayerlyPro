import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { multipartTransferLimitBytes } from "@/lib/request-body";
import { neverEndingBodyRequest } from "@/test/never-ending-body";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rateLimit: vi.fn(),
  saveUploadedFile: vi.fn(),
  reservePaymentProofUpload: vi.fn(),
  completePaymentProofUploadReservation: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/file", () => ({ saveUploadedFile: mocks.saveUploadedFile }));
vi.mock("@/modules/payment/proof-upload-quota", () => ({
  reservePaymentProofUpload: mocks.reservePaymentProofUpload,
  completePaymentProofUploadReservation: mocks.completePaymentProofUploadReservation,
}));

import { POST } from "./route";

function transferLimit(): number {
  return multipartTransferLimitBytes(getEnv().PAYMENT_PROOF_MAX_SIZE_MB);
}

function unreadRequest(headers: HeadersInit = {}): {
  request: NextRequest;
  getReader: ReturnType<typeof vi.fn>;
} {
  const request = new Request("http://localhost/api/files/upload-payment-proof", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=bounded-test",
      ...headers,
    },
  }) as NextRequest;
  const getReader = vi.fn();
  Object.defineProperty(request, "body", { value: { getReader } });
  return { request, getReader };
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

async function withShortTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("handler did not return before reading body")), 250);
    }),
  ]);
}

describe("payment proof multipart upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1", role: "fan" });
    mocks.rateLimit.mockReturnValue(true);
    mocks.saveUploadedFile.mockImplementation(async (input) => {
      await input.finalizeInTransaction?.({ transaction: "tx" });
      return { id: "file-1", originalName: "proof.png" };
    });
    mocks.reservePaymentProofUpload.mockResolvedValue("reservation-1");
    mocks.completePaymentProofUploadReservation.mockResolvedValue(undefined);
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
    expect(mocks.reservePaymentProofUpload).toHaveBeenCalledWith("user-1");
    expect(mocks.saveUploadedFile).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "payment_proof", createdBy: "user-1" }),
    );
    expect(mocks.completePaymentProofUploadReservation).toHaveBeenCalledWith(
      "reservation-1",
      true,
      { transaction: "tx" },
    );
  });

  it("marks the reservation failed only after transactional finalization rolls back", async () => {
    const form = new FormData();
    form.set("file", new File(["image"], "proof.png", { type: "image/png" }));
    mocks.completePaymentProofUploadReservation
      .mockRejectedValueOnce(new Error("reservation finalize failed"))
      .mockResolvedValueOnce(undefined);

    const response = await POST(
      new Request("http://localhost/api/files/upload-payment-proof", {
        method: "POST",
        body: form,
      }) as NextRequest,
    );

    expect(response.status).toBe(500);
    expect(mocks.completePaymentProofUploadReservation.mock.calls).toEqual([
      ["reservation-1", true, { transaction: "tx" }],
      ["reservation-1", false],
    ]);
  });

  it("rejects an oversized Content-Length after auth but before image handling, storage, or DB", async () => {
    const response = await POST(
      streamRequest([Uint8Array.from([1])], {
        "content-length": String(transferLimit() + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.requireUser).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(3);
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("rejects a chunked body that crosses the actual transfer limit", async () => {
    const limit = transferLimit();
    const response = await POST(streamRequest([new Uint8Array(limit), Uint8Array.from([1])]));

    expect(response.status).toBe(413);
    expect(mocks.requireUser).toHaveBeenCalledOnce();
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
    expect(mocks.requireUser).toHaveBeenCalledOnce();
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
    expect(mocks.requireUser).toHaveBeenCalledOnce();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("does not read an unauthenticated request body", async () => {
    const { request, getReader } = unreadRequest({ "content-length": String(transferLimit()) });
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("returns 401 before pulling a never-ending unauthenticated proof upload body", async () => {
    const slowBody = neverEndingBodyRequest("http://localhost/api/files/upload-payment-proof", {
      headers: {
        "content-type": "multipart/form-data; boundary=bounded-test",
      },
    });
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));

    try {
      const pullsBeforeHandler = slowBody.pulls;
      const response = await withShortTimeout(POST(slowBody.request));

      expect(response.status).toBe(401);
      expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
      expect(mocks.rateLimit.mock.calls[0]?.[0]).toBe("proof-upload-preauth-unresolved");
      expect(slowBody.pulls).toBe(pullsBeforeHandler);
      expect(mocks.reservePaymentProofUpload).not.toHaveBeenCalled();
      expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
    } finally {
      slowBody.cleanup();
    }
  });

  it("returns 429 from the pre-auth proof upload bucket without auth or body reads", async () => {
    const slowBody = neverEndingBodyRequest("http://localhost/api/files/upload-payment-proof", {
      headers: {
        "content-type": "multipart/form-data; boundary=bounded-test",
      },
    });
    mocks.rateLimit.mockReturnValue(false);

    try {
      const pullsBeforeHandler = slowBody.pulls;
      const response = await withShortTimeout(POST(slowBody.request));

      expect(response.status).toBe(429);
      expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
      expect(mocks.requireUser).not.toHaveBeenCalled();
      expect(slowBody.pulls).toBe(pullsBeforeHandler);
      expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
    } finally {
      slowBody.cleanup();
    }
  });

  it("calls post-auth proof upload buckets only after auth succeeds and before body parsing", async () => {
    const { request, getReader } = unreadRequest({ "content-length": String(transferLimit()) });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimit.mock.calls.map((call) => call[0])).toEqual([
      "proof-upload-preauth-unresolved",
      "proof-upload:user-1",
      "proof-upload-ip:unresolved",
    ]);
    expect(mocks.rateLimit.mock.invocationCallOrder[1]).toBeGreaterThan(
      mocks.requireUser.mock.invocationCallOrder[0]!,
    );
    expect(mocks.rateLimit.mock.invocationCallOrder[2]).toBeGreaterThan(
      mocks.requireUser.mock.invocationCallOrder[0]!,
    );
    expect(getReader).toHaveBeenCalledTimes(1);
    expect(mocks.saveUploadedFile).not.toHaveBeenCalled();
  });

  it("rejects a concurrent request at the pre-auth bucket before auth or body reads", async () => {
    let resolveFirstAuth!: (value: { id: string; role: string }) => void;
    mocks.requireUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstAuth = resolve;
        }),
    );
    mocks.rateLimit.mockReturnValue(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const first = unreadRequest({ "content-length": String(transferLimit()) });
    const second = unreadRequest({ "content-length": String(transferLimit()) });

    const firstResponsePromise = POST(first.request);
    await vi.waitFor(() => expect(mocks.requireUser).toHaveBeenCalledTimes(1));
    const secondResponse = await POST(second.request);

    expect(secondResponse.status).toBe(429);
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(first.getReader).not.toHaveBeenCalled();
    expect(second.getReader).not.toHaveBeenCalled();

    resolveFirstAuth({ id: "user-1", role: "fan" });
    await firstResponsePromise;
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
    expect(mocks.completePaymentProofUploadReservation).toHaveBeenCalledWith(
      "reservation-1",
      false,
    );
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
