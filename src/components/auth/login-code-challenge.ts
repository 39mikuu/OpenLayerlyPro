import {
  LOGIN_CODE_CHALLENGE_BYTES,
  LOGIN_CODE_CHALLENGE_PATTERN,
  normalizeEmail,
} from "@/modules/auth/input-policy";

const STORAGE_KEY = "auth.login-code-challenge";

type StoredChallenge = {
  email: string;
  challenge: string;
};

type ChallengeStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;
type ChallengeCrypto = Pick<Crypto, "getRandomValues">;

function readStoredChallenge(storage: ChallengeStorage): StoredChallenge | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChallenge>;
    if (
      typeof parsed.email !== "string" ||
      typeof parsed.challenge !== "string" ||
      !LOGIN_CODE_CHALLENGE_PATTERN.test(parsed.challenge)
    ) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return { email: parsed.email, challenge: parsed.challenge };
  } catch {
    storage.removeItem(STORAGE_KEY);
    return null;
  }
}

function generateChallenge(cryptoSource: ChallengeCrypto): string {
  const bytes = cryptoSource.getRandomValues(new Uint8Array(LOGIN_CODE_CHALLENGE_BYTES));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function getStoredLoginCodeChallenge(
  email: string,
  storage: ChallengeStorage = window.sessionStorage,
): string | null {
  const stored = readStoredChallenge(storage);
  return stored?.email === normalizeEmail(email) ? stored.challenge : null;
}

export function getOrCreateLoginCodeChallenge(
  email: string,
  storage: ChallengeStorage = window.sessionStorage,
  cryptoSource: ChallengeCrypto = window.crypto,
): string {
  const normalizedEmail = normalizeEmail(email);
  const existing = readStoredChallenge(storage);
  if (existing?.email === normalizedEmail) return existing.challenge;

  const challenge = generateChallenge(cryptoSource);
  storage.setItem(STORAGE_KEY, JSON.stringify({ email: normalizedEmail, challenge }));
  return challenge;
}

export function clearLoginCodeChallenge(
  email: string,
  storage: ChallengeStorage = window.sessionStorage,
): void {
  if (readStoredChallenge(storage)?.email === normalizeEmail(email)) {
    storage.removeItem(STORAGE_KEY);
  }
}
