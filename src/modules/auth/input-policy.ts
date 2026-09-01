import { z } from "zod";

export const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const DECIMAL_LOGIN_CODE_ALPHABET = "0123456789";

export const LOGIN_CODE_ALPHABETS = {
  decimal: DECIMAL_LOGIN_CODE_ALPHABET,
  "crockford-base32": CROCKFORD_BASE32_ALPHABET,
} as const;

export type LoginCodeAlphabet = keyof typeof LOGIN_CODE_ALPHABETS;

export const RAW_EMAIL_MAX_LENGTH = 512;
export const NORMALIZED_EMAIL_MAX_LENGTH = 254;
export const RAW_LOGIN_CODE_MAX_LENGTH = 128;
export const LOGIN_CODE_LENGTH = 6;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODE_CHALLENGE_BYTES = 32;
export const LOGIN_CODE_CHALLENGE_LENGTH = 43;
export const LEGACY_LOGIN_CODE_LENGTH = 16;
export const LEGACY_LOGIN_CODE_MAX_LENGTH = 64;

export const LOGIN_CODE_PATTERN = /^[0-9]{6}$/;
export const LEGACY_LOGIN_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16,64}$/;
export const LOGIN_CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const rawEmailSchema = z.string().min(1).max(RAW_EMAIL_MAX_LENGTH);
export const normalizedEmailSchema = z.string().email().max(NORMALIZED_EMAIL_MAX_LENGTH);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeLoginCode(code: string): string {
  return code.trim().toUpperCase();
}

export function sanitizeLoginCodeInput(code: string): string {
  const normalized = normalizeLoginCode(code);
  if (/^[0-9]*$/.test(normalized) && normalized.length <= LOGIN_CODE_LENGTH) return normalized;
  return normalized.replace(/[^0-9A-HJKMNP-TV-Z]/g, "").slice(0, LEGACY_LOGIN_CODE_MAX_LENGTH);
}

export function getLoginCodeAlphabet(alphabet: LoginCodeAlphabet): string {
  return LOGIN_CODE_ALPHABETS[alphabet];
}

export function getLoginCodePolicy(config?: {
  LOGIN_CODE_ALPHABET: LoginCodeAlphabet;
  LOGIN_CODE_LENGTH: number;
}) {
  void config;
  return {
    alphabet: DECIMAL_LOGIN_CODE_ALPHABET,
    alphabetName: "decimal" as const,
    length: LOGIN_CODE_LENGTH,
    pattern: LOGIN_CODE_PATTERN,
  };
}

export function validateNormalizedEmail(email: string): string {
  return normalizedEmailSchema.parse(email);
}

export function validateLoginCode(
  code: string,
  config?: { LOGIN_CODE_ALPHABET: LoginCodeAlphabet; LOGIN_CODE_LENGTH: number },
): string {
  void config;
  return z
    .string()
    .refine(
      (value) => LOGIN_CODE_PATTERN.test(value) || LEGACY_LOGIN_CODE_PATTERN.test(value),
      "Invalid login code",
    )
    .parse(code);
}

export function validateLoginCodeChallenge(challenge: string): string {
  return z
    .string()
    .length(LOGIN_CODE_CHALLENGE_LENGTH)
    .regex(LOGIN_CODE_CHALLENGE_PATTERN, "Invalid login code challenge")
    .parse(challenge);
}

export function isLegacyLoginCode(code: string): boolean {
  return LEGACY_LOGIN_CODE_PATTERN.test(code);
}

export function isLoginCodeComplete(code: string, length: number, pattern: RegExp): boolean {
  return (code.length === length && pattern.test(code)) || LEGACY_LOGIN_CODE_PATTERN.test(code);
}
