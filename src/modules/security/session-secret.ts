import { closeSync, constants, fstatSync, openSync, readFileSync } from "fs";

import { getEnv } from "@/lib/env";

const MIN_SECRET_LENGTH = 32;
const DEVELOPMENT_SECRET = "openlayerlypro-deterministic-development-session-secret";

let cachedSecret: string | undefined;

function invalidSecret(): never {
  throw new Error("SESSION_SECRET is missing or invalid");
}

function validateSecret(value: string, requireStrong: boolean): string {
  if (!value || value.trim().length === 0) invalidSecret();
  if (requireStrong && (value === "change-me" || value.length < MIN_SECRET_LENGTH)) {
    invalidSecret();
  }
  return value;
}

// Exported so a regression test can exercise this exact flag combination against a FIFO
// in a killable child process, without risking a hang in-process if it were ever weakened.
export const SECRET_FILE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function readSecretFile(path: string): string {
  let descriptor: number;
  try {
    // O_NONBLOCK prevents FIFO targets from hanging; it is a no-op for regular files.
    descriptor = openSync(path, SECRET_FILE_OPEN_FLAGS);
  } catch {
    throw new Error("session secret file is unreadable");
  }
  try {
    let metadata;
    try {
      metadata = fstatSync(descriptor);
    } catch {
      throw new Error("session secret file is unreadable");
    }
    if (!metadata.isFile()) throw new Error("session secret file is unreadable");
    let content: string;
    try {
      content = readFileSync(descriptor, "utf8");
    } catch {
      throw new Error("session secret file is unreadable");
    }
    const value = content.replace(/\r?\n$/, "");
    return validateSecret(value, true);
  } finally {
    closeSync(descriptor);
  }
}

export function getSessionSecret(): string {
  if (cachedSecret !== undefined) return cachedSecret;
  const env = getEnv();

  if (env.SESSION_SECRET !== undefined && env.SESSION_SECRET.length > 0) {
    cachedSecret = validateSecret(env.SESSION_SECRET, env.NODE_ENV === "production");
    return cachedSecret;
  }

  if (env.SESSION_SECRET_FILE) {
    cachedSecret = readSecretFile(env.SESSION_SECRET_FILE);
    return cachedSecret;
  }

  if (env.NODE_ENV !== "production") {
    cachedSecret = DEVELOPMENT_SECRET;
    return cachedSecret;
  }

  return invalidSecret();
}

export function resetSessionSecretCacheForTests(): void {
  cachedSecret = undefined;
}
