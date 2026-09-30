import { Socket } from "node:net";

import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import type { ResolvedSmtpConfig } from "@/modules/config/smtp";
import { TaskOwnershipLostError } from "@/modules/tasks/ownership";

// One owner, one TCP socket, including when Nodemailer wraps it for TLS/STARTTLS.
// SMTPTransport.close() alone does NOT destroy an active non-pooled connection.
export class LoginCodeTransport {
  private socket: Socket | undefined;
  private socketClosed: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly trustedCa?: string) {}

  async send(
    cfg: ResolvedSmtpConfig,
    message: { to: string; subject: string; text: string; html: string },
    signal?: AbortSignal,
    assertOwnership?: () => Promise<void>,
  ): Promise<void> {
    if (this.disposed || signal?.aborted) throw new TaskOwnershipLostError();
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const cancel = () => {
      this.disposed = true;
      this.socket?.destroy();
      rejectCancelled(new TaskOwnershipLostError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
    // A strict per-send cap is shorter than the freshly renewed 60s task lease.
    // It also bounds cancellation if a heartbeat's database request never returns.
    const deadline = setTimeout(cancel, 30_000);
    const options: SMTPTransport.Options = {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      tls: { ca: this.trustedCa },
      getSocket: (_options, callback) => {
        if (this.disposed || this.socket || signal?.aborted) {
          callback(new TaskOwnershipLostError(), {});
          return;
        }
        const socket = new Socket();
        this.socket = socket;
        this.socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        let returned = false;
        socket.on("error", () => {
          if (returned) return;
          returned = true;
          callback(new Error("SMTP connection failed"), {});
        });
        socket.connect(cfg.port, cfg.host ?? "localhost", () => {
          if (returned) return;
          returned = true;
          if (this.disposed || signal?.aborted) {
            socket.destroy();
            callback(new TaskOwnershipLostError(), {});
            return;
          }
          // DNS/TCP establishment may have waited. Renew again at the last safe
          // point before SMTP (including before credentials or DATA can be sent).
          void (async () => {
            try {
              await assertOwnership?.();
              if (this.disposed || signal?.aborted) throw new TaskOwnershipLostError();
              // Leave TLS negotiation to Nodemailer; certificate validation stays on.
              callback(null, { connection: socket });
            } catch {
              socket.destroy();
              callback(new TaskOwnershipLostError(), {});
            }
          })();
        });
      },
    };
    const transporter = nodemailer.createTransport(options);
    try {
      await Promise.race([transporter.sendMail({ from: cfg.from, ...message }), cancelled]);
      if (this.disposed || signal?.aborted) throw new TaskOwnershipLostError();
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      this.disposed = true;
      this.socket?.destroy();
      transporter.close();
    }
  }

  async closeConfirmed(): Promise<boolean> {
    // Fence late getSocket callbacks before establishing absence/close evidence.
    this.disposed = true;
    if (!this.socket) return true;
    this.socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.socketClosed!.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
