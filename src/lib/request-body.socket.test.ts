import { createServer, type IncomingHttpHeaders, request as sendHttpRequest } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { readBoundedRawBody, RequestBodyTooLargeError } from "./request-body";

function toHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

describe("bounded request bodies over HTTP", () => {
  it("returns 413 over a real socket without an unhandled stream rejection", async () => {
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", recordUnhandledRejection);

    const server = createServer(async (incoming, outgoing) => {
      try {
        const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
          method: incoming.method,
          headers: toHeaders(incoming.headers),
          body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        await readBoundedRawBody(request, 1024);
        outgoing.statusCode = 204;
      } catch (error) {
        outgoing.statusCode = error instanceof RequestBodyTooLargeError ? 413 : 500;
      }
      outgoing.end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing TCP address");

      const boundary = "socket-test";
      const multipartBody = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${"x".repeat(1024)}\r\n--${boundary}--\r\n`,
      );
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = sendHttpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/upload",
            method: "POST",
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.once("error", reject);
        request.write(multipartBody.subarray(0, 1024));
        request.end(multipartBody.subarray(1024));
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(status).toBe(413);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandledRejection);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
