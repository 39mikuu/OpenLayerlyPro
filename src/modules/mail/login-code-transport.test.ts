import { once } from "node:events";
import { createServer, type Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { LoginCodeTransport } from "./login-code-transport";

const message = { to: "fan@example.test", subject: "test", text: "123456", html: "<p>123456</p>" };

async function fixture(acceptData: boolean) {
  const sockets = new Set<Socket>();
  let dataEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    dataEntered = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    socket.write("220 local test SMTP\r\n");
    let buffer = "";
    let data = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (data) {
        if (buffer.includes("\r\n.\r\n")) {
          dataEntered();
          if (acceptData) socket.write("250 accepted\r\n");
        }
        return;
      }
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (line.startsWith("EHLO")) socket.write("250-local\r\n250 OK\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 go\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing local SMTP port");
  return {
    entered,
    sockets,
    cfg: {
      configured: true,
      host: "127.0.0.1",
      port: address.port,
      secure: false,
      from: "sender@example.test",
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

describe("exclusive login-code SMTP socket", () => {
  it("destroys an in-flight DATA socket on abort and confirms teardown", async () => {
    const smtp = await fixture(false);
    const transport = new LoginCodeTransport();
    const controller = new AbortController();
    try {
      const send = transport.send(smtp.cfg, message, controller.signal);
      const rejected = expect(send).rejects.toMatchObject({ name: "TaskOwnershipLostError" });
      await smtp.entered;
      const peer = [...smtp.sockets][0];
      const closed = once(peer, "close");
      controller.abort();
      await rejected;
      expect(await transport.closeConfirmed()).toBe(true);
      await closed;
      expect(smtp.sockets.size).toBe(0);
    } finally {
      await smtp.close();
    }
  });

  it("cancelling one send does not close another send's socket", async () => {
    const a = await fixture(false);
    const b = await fixture(true);
    const first = new LoginCodeTransport();
    const second = new LoginCodeTransport();
    const controller = new AbortController();
    try {
      const failure = expect(first.send(a.cfg, message, controller.signal)).rejects.toThrow();
      await a.entered;
      controller.abort();
      await failure;
      expect(await first.closeConfirmed()).toBe(true);
      await second.send(b.cfg, message);
      expect(await second.closeConfirmed()).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("pre-aborted and disposed transports never create sockets", async () => {
    const smtp = await fixture(true);
    const transport = new LoginCodeTransport();
    try {
      expect(await transport.closeConfirmed()).toBe(true);
      await expect(transport.send(smtp.cfg, message)).rejects.toThrow();
      const controller = new AbortController();
      controller.abort();
      await expect(
        new LoginCodeTransport().send(smtp.cfg, message, controller.signal),
      ).rejects.toThrow();
      expect(smtp.sockets.size).toBe(0);
    } finally {
      await smtp.close();
    }
  });

  it("does not call destroy intent positive close evidence", async () => {
    // Fault injection: kernel/stream never confirms teardown. Keep reservation.
    const transport = new LoginCodeTransport();
    const internals = transport as unknown as {
      socket: { destroy: () => void };
      socketClosed: Promise<void>;
    };
    internals.socket = { destroy: vi.fn() };
    internals.socketClosed = new Promise(() => undefined);
    expect(await transport.closeConfirmed()).toBe(false);
  });
});
