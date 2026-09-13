import {
  LOGIN_CODE_CHALLENGE_BYTES,
  LOGIN_CODE_CHALLENGE_PATTERN,
  normalizeEmail,
} from "@/modules/auth/input-policy";

const STORAGE_KEY = "auth.login-code-challenge";
const PENDING_FLOW_KEY = "auth.login-code-pending";
export const LOGIN_CODE_PENDING_FLOW_TTL_MS = 10 * 60 * 1000;

type StoredChallenge = {
  email: string;
  challenge: string;
  exhaustedChallenge?: string;
  expiresAt?: number;
};

type PendingLoginCodeFlow = {
  email: string;
  expiresAt: number;
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
    if (
      parsed.expiresAt !== undefined &&
      (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now())
    ) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return {
      email: parsed.email,
      challenge: parsed.challenge,
      exhaustedChallenge:
        typeof parsed.exhaustedChallenge === "string" &&
        LOGIN_CODE_CHALLENGE_PATTERN.test(parsed.exhaustedChallenge)
          ? parsed.exhaustedChallenge
          : undefined,
      expiresAt: parsed.expiresAt,
    };
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

function persistChallenge(email: string, challenge: string, storage: ChallengeStorage): string {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ email, challenge, expiresAt: Date.now() + LOGIN_CODE_PENDING_FLOW_TTL_MS }),
  );
  return challenge;
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
  if (existing?.email === normalizedEmail) {
    // Persist before sending: a successful resend with a lost response must
    // not outlive its browser-held challenge. Preserve a pending rotation.
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...existing,
        expiresAt: Date.now() + LOGIN_CODE_PENDING_FLOW_TTL_MS,
      }),
    );
    return existing.challenge;
  }

  return persistChallenge(normalizedEmail, generateChallenge(cryptoSource), storage);
}

export function rotateLoginCodeChallenge(
  email: string,
  storage: ChallengeStorage = window.sessionStorage,
  cryptoSource: ChallengeCrypto = window.crypto,
  exhaustedChallenge?: string,
): string {
  const normalizedEmail = normalizeEmail(email);
  const existing = readStoredChallenge(storage);
  const exhausted = exhaustedChallenge ?? existing?.challenge;
  if (existing?.email === normalizedEmail && existing.exhaustedChallenge === exhausted) {
    return existing.challenge;
  }
  const replacement = generateChallenge(cryptoSource);
  if (replacement === exhausted) throw new Error("Challenge rotation failed");
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      email: normalizedEmail,
      challenge: replacement,
      exhaustedChallenge: exhausted,
      expiresAt: Date.now() + LOGIN_CODE_PENDING_FLOW_TTL_MS,
    }),
  );
  return replacement;
}

export function clearLoginCodeChallenge(
  email: string,
  storage: ChallengeStorage = window.sessionStorage,
): void {
  if (readStoredChallenge(storage)?.email === normalizeEmail(email)) {
    storage.removeItem(STORAGE_KEY);
  }
}

function readPendingLoginCodeFlow(
  storage: ChallengeStorage,
  now: number,
): PendingLoginCodeFlow | null {
  try {
    const raw = storage.getItem(PENDING_FLOW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingLoginCodeFlow>;
    if (typeof parsed.email !== "string" || typeof parsed.expiresAt !== "number") {
      storage.removeItem(PENDING_FLOW_KEY);
      return null;
    }
    if (parsed.expiresAt <= now) {
      storage.removeItem(PENDING_FLOW_KEY);
      return null;
    }
    return { email: parsed.email, expiresAt: parsed.expiresAt };
  } catch {
    storage.removeItem(PENDING_FLOW_KEY);
    return null;
  }
}

export function rememberPendingLoginCodeFlow(
  email: string,
  storage: ChallengeStorage = window.localStorage,
  now: number = Date.now(),
): void {
  storage.setItem(
    PENDING_FLOW_KEY,
    JSON.stringify({
      email: normalizeEmail(email),
      expiresAt: now + LOGIN_CODE_PENDING_FLOW_TTL_MS,
    }),
  );
}

export function getPendingLoginCodeFlow(
  email: string,
  storage: ChallengeStorage = window.localStorage,
  now: number = Date.now(),
): PendingLoginCodeFlow | null {
  const pending = readPendingLoginCodeFlow(storage, now);
  return pending?.email === normalizeEmail(email) ? pending : null;
}

export function clearPendingLoginCodeFlow(
  email: string,
  storage: ChallengeStorage = window.localStorage,
  now: number = Date.now(),
): void {
  const pending = readPendingLoginCodeFlow(storage, now);
  if (pending?.email === normalizeEmail(email)) {
    storage.removeItem(PENDING_FLOW_KEY);
  }
}

export function hasLostLoginCodeChallenge(
  email: string,
  challengeStorage: ChallengeStorage = window.sessionStorage,
  markerStorage: ChallengeStorage = window.localStorage,
  now: number = Date.now(),
): boolean {
  return (
    getPendingLoginCodeFlow(email, markerStorage, now) !== null &&
    getStoredLoginCodeChallenge(email, challengeStorage) === null
  );
}

export function getLoginCodeRecoveryChallenge(
  email: string,
  storage: ChallengeStorage = window.sessionStorage,
): string | null {
  const stored = readStoredChallenge(storage);
  return stored?.email === normalizeEmail(email)
    ? (stored.exhaustedChallenge ?? stored.challenge)
    : null;
}

/** Probe the current proposal first so a lost exhaustion response can advance
 * another generation even while its predecessor tuple is still retained. */
export async function recoverLoginCodeChallenge(
  email: string,
  probe: (challenge: string) => Promise<boolean>,
  storage: ChallengeStorage = window.sessionStorage,
  cryptoSource: ChallengeCrypto = window.crypto,
): Promise<void> {
  const candidates = new Set([
    getStoredLoginCodeChallenge(email, storage),
    getLoginCodeRecoveryChallenge(email, storage),
  ]);
  for (const challenge of candidates) {
    if (challenge && (await probe(challenge))) {
      rotateLoginCodeChallenge(email, storage, cryptoSource, challenge);
      return;
    }
  }
}

/** Accepted is deliberately uniform, not proof that this successor won. */
export function acknowledgeLoginCodeReplacement(
  email: string,
  storage: ChallengeStorage = window.sessionStorage,
): void {
  const stored = readStoredChallenge(storage);
  if (stored?.email === normalizeEmail(email)) {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...stored, expiresAt: Date.now() + LOGIN_CODE_PENDING_FLOW_TTL_MS }),
    );
  }
}
