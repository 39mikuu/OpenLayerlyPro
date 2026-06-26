import { z } from "zod";

export const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const LOGIN_CODE_ALPHABETS = {
  "crockford-base32": CROCKFORD_BASE32_ALPHABET,
} as const;

export type LoginCodeAlphabet = keyof typeof LOGIN_CODE_ALPHABETS;

export const RAW_EMAIL_MAX_LENGTH = 512;
export const NORMALIZED_EMAIL_MAX_LENGTH = 254;
export const RAW_LOGIN_CODE_MAX_LENGTH = 128;

export const rawEmailSchema = z.string().min(1).max(RAW_EMAIL_MAX_LENGTH);
export const normalizedEmailSchema = z.string().email().max(NORMALIZED_EMAIL_MAX_LENGTH);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeLoginCode(code: string): string {
  return code.trim().toUpperCase();
}

export const sanitizeLoginCodeInput = normalizeLoginCode;

export function getLoginCodeAlphabet(alphabet: LoginCodeAlphabet): string {
  return LOGIN_CODE_ALPHABETS[alphabet];
}

export function getLoginCodePolicy(config: {
  LOGIN_CODE_ALPHABET: LoginCodeAlphabet;
  LOGIN_CODE_LENGTH: number;
}) {
  const alphabet = getLoginCodeAlphabet(config.LOGIN_CODE_ALPHABET);
  return {
    alphabet,
    alphabetName: config.LOGIN_CODE_ALPHABET,
    length: config.LOGIN_CODE_LENGTH,
    pattern: new RegExp(
      `^[${alphabet.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}]{${config.LOGIN_CODE_LENGTH}}$`,
    ),
  };
}

export function validateNormalizedEmail(email: string): string {
  return normalizedEmailSchema.parse(email);
}

export function validateLoginCode(
  code: string,
  config: { LOGIN_CODE_ALPHABET: LoginCodeAlphabet; LOGIN_CODE_LENGTH: number },
): string {
  const policy = getLoginCodePolicy(config);
  return z.string().regex(policy.pattern, "Invalid login code").parse(code);
}

export function isLoginCodeComplete(code: string, length: number, pattern: RegExp): boolean {
  return code.length === length && pattern.test(code);
}
