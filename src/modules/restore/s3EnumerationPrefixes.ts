/** Controlled S3 key namespaces used by the application (see file/index PURPOSE_DIRS and backfillSafety). */
export const APP_STORAGE_OBJECT_PREFIXES = [
  "avatars/",
  "payment-qr/",
  "payment-proof/",
  "content/",
  "legacy/",
  "remediated/",
] as const;

export type AppStorageObjectPrefix = (typeof APP_STORAGE_OBJECT_PREFIXES)[number];

export function validateS3EnumerationPrefix(prefix: string): void {
  const trimmed = prefix.trim();
  if (!trimmed) {
    throw new Error("S3 enumeration prefix must not be empty");
  }
  if (!trimmed.endsWith("/")) {
    throw new Error("S3 enumeration prefix must end with '/'");
  }
  if (trimmed.startsWith("/")) {
    throw new Error("S3 enumeration prefix must not start with '/'");
  }
  if (trimmed.includes("..")) {
    throw new Error("S3 enumeration prefix must not contain '..'");
  }
}

export function parseS3EnumerationPrefixes(input?: string | readonly string[]): string[] {
  if (typeof input === "string" && input.trim()) {
    const prefixes = input
      .split(",")
      .map((prefix) => prefix.trim())
      .filter(Boolean);
    for (const prefix of prefixes) validateS3EnumerationPrefix(prefix);
    return prefixes;
  }

  if (Array.isArray(input) && input.length > 0) {
    const prefixes = input.map((prefix) => prefix.trim()).filter(Boolean);
    for (const prefix of prefixes) validateS3EnumerationPrefix(prefix);
    return prefixes;
  }

  const env = process.env.RESTORE_S3_ENUM_PREFIXES?.trim();
  if (env) {
    return parseS3EnumerationPrefixes(env);
  }

  return [...APP_STORAGE_OBJECT_PREFIXES];
}
