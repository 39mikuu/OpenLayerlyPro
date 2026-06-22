import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  InvalidContentLengthError,
  InvalidJsonBodyError,
  multipartTransferLimitBytes,
  readBoundedRawBody,
  readFormDataWithLimit,
  readJsonWithLimit,
  readTextWithLimit,
  RequestBodyReadError,
  RequestBodyTooLargeError,
} from "./request-body";

function requestWithBody(body: BodyInit | null, headers?: HeadersInit, method = "POST"): Request {
  return new Request("http://localhost/test", {
    method,
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function requestWithReader(
  reader: {
    read: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  },
  headers?: HeadersInit,
): Request {
  const request = requestWithBody(null, headers);
  Object.defineProperty(request, "body", {
    configurable: true,
    value: { getReader: () => reader },
  });
  return request;
}

describe("readBoundedRawBody", () => {
  it("accepts declared and actual lengths below or exactly at the byte limit", async () => {
    await expect(
      readBoundedRawBody(requestWithBody("abc", { "content-length": "3" }), 4),
    ).resolves.toEqual(Buffer.from("abc"));
    await expect(
      readBoundedRawBody(requestWithBody("abcd", { "content-length": "4" }), 4),
    ).resolves.toEqual(Buffer.from("abcd"));
  });

  it("rejects an oversized declared length before touching the stream", async () => {
    const reader = {
      read: vi.fn(),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const request = requestWithReader(reader, { "content-length": "5" });

    await expect(readBoundedRawBody(request, 4)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("reads bodies without Content-Length and enforces actual chunked bytes", async () => {
    const accepted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4]));
        controller.close();
      },
    });
    await expect(readBoundedRawBody(requestWithBody(accepted), 4)).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.enqueue(Uint8Array.from([4, 5]));
        controller.close();
      },
    });
    await expect(readBoundedRawBody(requestWithBody(oversized), 4)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("does not trust a smaller declared length", async () => {
    await expect(
      readBoundedRawBody(requestWithBody("abcde", { "content-length": "1" }), 4),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it.each(["", "-1", "+1", "1.5", "01", "NaN", "Infinity", "9007199254740992"])(
    "rejects malformed Content-Length %j",
    async (value) => {
      await expect(
        readBoundedRawBody(requestWithBody("", { "content-length": value }), 4),
      ).rejects.toBeInstanceOf(InvalidContentLengthError);
    },
  );

  it("rejects a raw Content-Length value with surrounding whitespace", async () => {
    const request = {
      headers: { get: () => " 1" },
      body: null,
    } as unknown as Request;

    await expect(readBoundedRawBody(request, 4)).rejects.toBeInstanceOf(InvalidContentLengthError);
  });

  it("handles an empty stream and request.body === null", async () => {
    await expect(readBoundedRawBody(requestWithBody(""), 4)).resolves.toEqual(Buffer.alloc(0));
    const request = new Request("http://localhost/test", { method: "POST" });
    expect(request.body).toBeNull();
    await expect(readBoundedRawBody(request, 4)).resolves.toEqual(Buffer.alloc(0));
  });

  it("maps an interrupted client stream to a stable read error", async () => {
    const reader = {
      read: vi.fn().mockRejectedValue(new Error("client disconnected")),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    await expect(readBoundedRawBody(requestWithReader(reader), 4)).rejects.toBeInstanceOf(
      RequestBodyReadError,
    );
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it("cancels immediately on overflow and does not read another chunk", async () => {
    const reader = {
      read: vi.fn().mockResolvedValueOnce({
        done: false,
        value: Uint8Array.from([1, 2, 3, 4, 5]),
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };

    await expect(readBoundedRawBody(requestWithReader(reader), 4)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    expect(reader.read).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it("preserves raw bytes without decoding, trimming, or normalization", async () => {
    const bytes = Uint8Array.from([0, 10, 13, 32, 0xc3, 0xa9, 255]);
    await expect(readBoundedRawBody(requestWithBody(bytes), bytes.byteLength)).resolves.toEqual(
      Buffer.from(bytes),
    );
  });
});

describe("readJsonWithLimit", () => {
  const schema = z.object({ value: z.string() });

  it("parses valid JSON only after the bounded byte read", async () => {
    await expect(readJsonWithLimit(requestWithBody('{"value":"ok"}'), 32, schema)).resolves.toEqual(
      {
        value: "ok",
      },
    );
  });

  it("accepts JSON exactly at the byte boundary", async () => {
    const body = '{"value":"ok"}';
    await expect(
      readJsonWithLimit(requestWithBody(body), Buffer.byteLength(body), schema),
    ).resolves.toEqual({ value: "ok" });
  });

  it("distinguishes malformed JSON from an oversized payload", async () => {
    await expect(readJsonWithLimit(requestWithBody("{"), 4, schema)).rejects.toBeInstanceOf(
      InvalidJsonBodyError,
    );
    await expect(
      readJsonWithLimit(
        requestWithBody('{"value":"too-large"}', { "content-length": "999" }),
        16,
        schema,
      ),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const body = '{"value":"你"}';
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
    await expect(
      readJsonWithLimit(requestWithBody(body), body.length, schema),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    await expect(
      readJsonWithLimit(requestWithBody(body), Buffer.byteLength(body), schema),
    ).resolves.toEqual({ value: "你" });
  });

  it("does not invoke Zod when the transfer limit is exceeded", async () => {
    const parseSpy = vi.spyOn(schema, "parse");
    await expect(
      readJsonWithLimit(requestWithBody('{"value":"ok"}', { "content-length": "100" }), 16, schema),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });
});

describe("text and multipart helpers", () => {
  it("decodes bounded UTF-8 text without trimming", async () => {
    await expect(readTextWithLimit(requestWithBody("  你好\n"), 16)).resolves.toBe("  你好\n");
  });

  it("buffers multipart transfer bytes before parsing FormData", async () => {
    const form = new FormData();
    form.set("purpose", "payment_proof");
    form.set("file", new File(["image"], "proof.png", { type: "image/png" }));
    const request = new Request("http://localhost/test", { method: "POST", body: form });
    const parsed = await readFormDataWithLimit(request, 1024);
    expect(parsed.get("purpose")).toBe("payment_proof");
    expect(parsed.get("file")).toBeInstanceOf(File);
  });

  it("adds explicit multipart protocol overhead to the file limit", () => {
    expect(multipartTransferLimitBytes(1)).toBe(1024 * 1024 + 256 * 1024);
  });
});
