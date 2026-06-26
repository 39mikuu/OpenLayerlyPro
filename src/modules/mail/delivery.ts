import { ApiError } from "@/lib/api";

export type MailFailureKind = "permanent" | "transient" | "needs_operator";

type MailErrorShape = {
  code?: unknown;
  responseCode?: unknown;
};

const TRANSIENT_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ECONNREFUSED",
  "ECONNRESET",
]);

function errorShape(error: unknown): MailErrorShape {
  return typeof error === "object" && error !== null ? (error as MailErrorShape) : {};
}

export function classifyMailError(error: unknown): MailFailureKind {
  if (error instanceof MailDeliveryError) return error.kind;
  if (error instanceof ApiError && error.code === "mailNotConfigured") return "needs_operator";

  const shape = errorShape(error);
  const code = typeof shape.code === "string" ? shape.code.toUpperCase() : undefined;
  const responseCode =
    typeof shape.responseCode === "number" && Number.isFinite(shape.responseCode)
      ? shape.responseCode
      : undefined;

  if (code === "EAUTH") return "needs_operator";
  if (responseCode !== undefined && responseCode >= 500 && responseCode <= 599) {
    return "permanent";
  }
  if (responseCode !== undefined && responseCode >= 400 && responseCode <= 499) {
    return "transient";
  }
  if (code && TRANSIENT_CODES.has(code)) return "transient";

  return "transient";
}

export class MailDeliveryError extends Error {
  readonly kind: MailFailureKind;

  constructor(kind: MailFailureKind) {
    super("SMTP delivery failed");
    this.name = "MailDeliveryError";
    this.kind = kind;
  }
}
