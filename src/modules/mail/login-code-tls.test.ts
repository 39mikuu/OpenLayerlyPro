import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, createServer as createTlsServer, TLSSocket } from "node:tls";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LoginCodeTransport } from "./login-code-transport";

let directory: string;
let key: string;
let cert: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "olp-smtp-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(directory, "key.pem"), "utf8");
  cert = readFileSync(join(directory, "cert.pem"), "utf8");
});
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe.each(["tls", "starttls"] as const)("login SMTP %s socket", (mode) => {
  it("cancels during encrypted DATA and confirms underlying socket close", async () => {
    const sockets = new Set<Socket>();
    let entered!: () => void;
    const dataReceived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const accept = (socket: Socket, secured: boolean, greeting = true) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => sockets.delete(socket));
      if (greeting) socket.write("220 test\r\n");
      let buffer = "";
      let data = false;
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (data) {
          if (buffer.includes("\r\n.\r\n")) entered();
          return;
        }
        while (buffer.includes("\r\n")) {
          const end = buffer.indexOf("\r\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (line.startsWith("EHLO"))
            socket.write(secured ? "250 test\r\n" : "250-test\r\n250 STARTTLS\r\n");
          else if (line === "STARTTLS") {
            socket.removeListener("data", onData);
            socket.write("220 start TLS\r\n");
            const tls = new TLSSocket(socket, {
              isServer: true,
              secureContext: createSecureContext({ key, cert }),
            });
            accept(tls, true, false);
            return;
          } else if (line === "DATA") {
            data = true;
            socket.write("354 data\r\n");
          } else socket.write("250 ok\r\n");
        }
      };
      socket.on("data", onData);
    };
    const server =
      mode === "tls"
        ? createTlsServer({ key, cert }, (socket) => accept(socket, true))
        : createServer((socket) => accept(socket, false));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const transport = new LoginCodeTransport(cert);
    const controller = new AbortController();
    try {
      const result = transport.send(
        {
          configured: true,
          host: "127.0.0.1",
          port: address.port,
          secure: mode === "tls",
          from: "test@example.test",
        },
        { to: "fan@example.test", subject: "test", text: "123456", html: "<p>123456</p>" },
        controller.signal,
      );
      const rejected = expect(result).rejects.toMatchObject({ name: "TaskOwnershipLostError" });
      await dataReceived;
      const closures = [...sockets].map((socket) => once(socket, "close"));
      controller.abort();
      await rejected;
      expect(await transport.closeConfirmed()).toBe(true);
      await Promise.all(closures);
      expect(sockets.size).toBe(0);
    } finally {
      await transport.closeConfirmed();
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    }
  }, 10_000);
});
