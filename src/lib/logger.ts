const SENSITIVE_KEYS = [
  "password",
  "password_hash",
  "passwordHash",
  "code",
  "code_hash",
  "codeHash",
  "token",
  "token_hash",
  "tokenHash",
  "secret",
  "smtp_password",
  "smtpPassword",
  "s3_secret_access_key",
  "s3SecretAccessKey",
  "authorization",
  "cookie",
];

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))
        ? "[REDACTED]"
        : redact(v);
    }
    return out;
  }
  return value;
}

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
};
