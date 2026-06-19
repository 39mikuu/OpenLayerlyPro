import { createHash } from "crypto";
import { Transform } from "stream";

export class StorageObjectTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Storage object exceeds ${maxBytes} bytes`);
    this.name = "StorageObjectTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export function createMeasuredStream(maxBytes: number): {
  stream: Transform;
  result: () => { sizeBytes: number; sha256: string };
} {
  let sizeBytes = 0;
  const hash = createHash("sha256");
  let digested = false;

  const stream = new Transform({
    transform(chunk: Buffer | Uint8Array | string, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, encoding)
          : Buffer.from(chunk);
      const nextSize = sizeBytes + buffer.byteLength;
      if (nextSize > maxBytes) {
        callback(new StorageObjectTooLargeError(maxBytes));
        return;
      }
      sizeBytes = nextSize;
      hash.update(buffer);
      callback(null, buffer);
    },
  });

  return {
    stream,
    result: () => {
      if (digested) throw new Error("Stream digest has already been read");
      digested = true;
      return { sizeBytes, sha256: hash.digest("hex") };
    },
  };
}
