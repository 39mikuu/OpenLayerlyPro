import { readFileSync } from "fs";

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

function readSecretFile(path: string): string {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new Error("session secret file is unreadable");
  }
  const value = content.replace(/\r?\n$/, "");
  return validateSecret(value, true);
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
