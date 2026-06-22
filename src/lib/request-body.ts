import type { ZodType } from "zod";

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the configured byte limit");
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidContentLengthError extends Error {
  constructor() {
    super("Content-Length must be a non-negative safe integer");
    this.name = "InvalidContentLengthError";
  }
}

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("Request body is not valid UTF-8 JSON");
    this.name = "InvalidJsonBodyError";
  }
}

export class InvalidTextBodyError extends Error {
  constructor() {
    super("Request body is not valid UTF-8 text");
    this.name = "InvalidTextBodyError";
  }
}

export class InvalidMultipartBodyError extends Error {
  constructor() {
    super("Request body is not valid multipart form data");
    this.name = "InvalidMultipartBodyError";
  }
}

export class RequestBodyReadError extends Error {
  constructor() {
    super("Request body stream could not be read completely");
    this.name = "RequestBodyReadError";
  }
}

const UTF8_DECODER_OPTIONS: TextDecoderOptions = { fatal: true };

function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new InvalidContentLengthError();

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidContentLengthError();
  return parsed;
}

function decodeUtf8(rawBody: Uint8Array, invalidBodyError: Error): string {
  try {
    return new TextDecoder("utf-8", UTF8_DECODER_OPTIONS).decode(rawBody);
  } catch {
    throw invalidBodyError;
  }
}

/** Read an exact, unmodified request body while enforcing a byte limit before buffering it. */
export async function readBoundedRawBody(request: Request, maxBytes: number): Promise<Buffer> {
  assertMaxBytes(maxBytes);

  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  if (request.body === null) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new RequestBodyReadError();
      if (value.byteLength === 0) continue;

      // Subtraction avoids overflowing the accumulator before the comparison.
      if (value.byteLength > maxBytes - totalBytes) {
        try {
          void reader.cancel("request body exceeded byte limit").catch(() => {});
        } catch {
          // Cancellation is best-effort; the stable 413 error must not be masked.
        }
        throw new RequestBodyTooLargeError();
      }

      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    if (
      error instanceof RequestBodyTooLargeError ||
      error instanceof RequestBodyReadError ||
      error instanceof InvalidContentLengthError
    ) {
      throw error;
    }
    throw new RequestBodyReadError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing an already-failed stream must not mask the stable domain error.
    }
  }

  return Buffer.concat(chunks, totalBytes);
}

export function parseJsonBody<T>(rawBody: Uint8Array, schema: ZodType<T>): T {
  const text = decodeUtf8(rawBody, new InvalidJsonBodyError());
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidJsonBodyError();
  }
  return schema.parse(value);
}

export async function readJsonWithLimit<T>(
  request: Request,
  maxBytes: number,
  schema: ZodType<T>,
): Promise<T> {
  return parseJsonBody(await readBoundedRawBody(request, maxBytes), schema);
}

export async function readJsonWithLimitOrDefault<T>(
  request: Request,
  maxBytes: number,
  schema: ZodType<T>,
  emptyBodyValue: unknown,
): Promise<T> {
  const rawBody = await readBoundedRawBody(request, maxBytes);
  return rawBody.byteLength === 0 ? schema.parse(emptyBodyValue) : parseJsonBody(rawBody, schema);
}

export async function readTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const rawBody = await readBoundedRawBody(request, maxBytes);
  return decodeUtf8(rawBody, new InvalidTextBodyError());
}

export async function readFormDataWithLimit(request: Request, maxBytes: number): Promise<FormData> {
  const rawBody = await readBoundedRawBody(request, maxBytes);
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers),
    body: Uint8Array.from(rawBody),
  });

  try {
    return await boundedRequest.formData();
  } catch {
    throw new InvalidMultipartBodyError();
  }
}

export const MULTIPART_TRANSFER_OVERHEAD_BYTES = 256 * 1024;

export function multipartTransferLimitBytes(fileLimitMb: number): number {
  if (!Number.isSafeInteger(fileLimitMb) || fileLimitMb <= 0) {
    throw new RangeError("fileLimitMb must be a positive safe integer");
  }
  const fileBytes = fileLimitMb * 1024 * 1024;
  if (!Number.isSafeInteger(fileBytes + MULTIPART_TRANSFER_OVERHEAD_BYTES)) {
    throw new RangeError("multipart transfer limit exceeds the safe integer range");
  }
  return fileBytes + MULTIPART_TRANSFER_OVERHEAD_BYTES;
}
