import { describe, expect, it, vi } from "vitest";

import {
  acknowledgeLoginCodeReplacement,
  clearLoginCodeChallenge,
  clearPendingLoginCodeFlow,
  getLoginCodeRecoveryChallenge,
  getOrCreateLoginCodeChallenge,
  getPendingLoginCodeFlow,
  getStoredLoginCodeChallenge,
  hasLostLoginCodeChallenge,
  LOGIN_CODE_PENDING_FLOW_TTL_MS,
  recoverLoginCodeChallenge,
  rememberPendingLoginCodeFlow,
  rotateLoginCodeChallenge,
} from "./login-code-challenge";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

function cryptoSource(fillStart = 1) {
  let fill = fillStart;
  return {
    getRandomValues: vi.fn((bytes: Uint8Array) => {
      bytes.fill(fill++);
      return bytes;
    }),
  };
}

describe("login code browser challenge", () => {
  it("retains the same challenge through a near-expiry resend with a lost acknowledgement", () => {
    const clock = vi.spyOn(Date, "now");
    const session = storage();
    const crypto = cryptoSource();
    try {
      clock.mockReturnValue(1_700_000_000_000);
      const original = getOrCreateLoginCodeChallenge("fan@example.com", session, crypto);
      clock.mockReturnValue(1_700_000_540_000);
      expect(getOrCreateLoginCodeChallenge("fan@example.com", session, crypto)).toBe(original);
      clock.mockReturnValue(1_700_000_660_000);
      expect(getStoredLoginCodeChallenge("fan@example.com", session)).toBe(original);
      expect(crypto.getRandomValues).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });
  it("generates 32 random bytes and reuses them for normalized-email resends", () => {
    const session = storage();
    const crypto = {
      getRandomValues: vi.fn((bytes: Uint8Array) => {
        bytes.forEach((_value, index) => {
          bytes[index] = index;
        });
        return bytes;
      }),
    };

    const first = getOrCreateLoginCodeChallenge(" Fan@Example.com ", session, crypto);
    const resend = getOrCreateLoginCodeChallenge("fan@example.com", session, crypto);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resend).toBe(first);
    expect(crypto.getRandomValues).toHaveBeenCalledOnce();
    expect(crypto.getRandomValues.mock.calls[0]?.[0]).toHaveLength(32);
  });

  it("rotates on email change and clears only the matching flow", () => {
    const session = storage();
    const crypto = cryptoSource();

    const first = getOrCreateLoginCodeChallenge("first@example.com", session, crypto);
    const second = getOrCreateLoginCodeChallenge("second@example.com", session, crypto);

    expect(second).not.toBe(first);
    expect(getStoredLoginCodeChallenge("first@example.com", session)).toBeNull();
    clearLoginCodeChallenge("first@example.com", session);
    expect(getStoredLoginCodeChallenge("second@example.com", session)).toBe(second);
    clearLoginCodeChallenge("second@example.com", session);
    expect(getStoredLoginCodeChallenge("second@example.com", session)).toBeNull();
  });

  it("discards malformed persisted values", () => {
    const session = storage();
    session.setItem(
      "auth.login-code-challenge",
      JSON.stringify({ email: "fan@example.com", challenge: "not-valid" }),
    );

    expect(getStoredLoginCodeChallenge("fan@example.com", session)).toBeNull();
    expect(session.removeItem).toHaveBeenCalled();
  });

  it("rotates the stored challenge for the same email", () => {
    const session = storage();
    const crypto = cryptoSource();

    const first = getOrCreateLoginCodeChallenge("fan@example.com", session, crypto);
    const rotated = rotateLoginCodeChallenge(" Fan@Example.com ", session, crypto);

    expect(rotated).not.toBe(first);
    expect(getStoredLoginCodeChallenge("fan@example.com", session)).toBe(rotated);
    expect(getOrCreateLoginCodeChallenge("fan@example.com", session, crypto)).toBe(rotated);
    expect(crypto.getRandomValues).toHaveBeenCalledTimes(2);
  });

  it("persists a non-secret pending-flow marker without the raw challenge", () => {
    const marker = storage();
    const now = 1_700_000_000_000;

    rememberPendingLoginCodeFlow(" Fan@Example.com ", marker, now);

    const pending = getPendingLoginCodeFlow("fan@example.com", marker, now);
    expect(pending).toEqual({
      email: "fan@example.com",
      expiresAt: now + LOGIN_CODE_PENDING_FLOW_TTL_MS,
    });
    expect(JSON.stringify(marker.setItem.mock.calls)).not.toContain("challenge");
    expect(getPendingLoginCodeFlow("other@example.com", marker, now)).toBeNull();
    expect(marker.removeItem).not.toHaveBeenCalled();
  });

  it("expires the pending-flow marker after ten minutes", () => {
    const marker = storage();
    const now = 1_700_000_000_000;
    rememberPendingLoginCodeFlow("fan@example.com", marker, now);

    expect(
      getPendingLoginCodeFlow("fan@example.com", marker, now + LOGIN_CODE_PENDING_FLOW_TTL_MS),
    ).toBeNull();
    expect(marker.removeItem).toHaveBeenCalled();
  });

  it("allows same-page resend after TTL while blocking challenge loss before TTL", async () => {
    const clock = vi.spyOn(Date, "now");
    const session = storage();
    const marker = storage();
    const crypto = cryptoSource();
    const start = 1_700_000_000_000;
    try {
      clock.mockReturnValue(start);
      const original = getOrCreateLoginCodeChallenge("fan@example.com", session, crypto);
      rememberPendingLoginCodeFlow("fan@example.com", marker, start);
      clearLoginCodeChallenge("fan@example.com", session);
      clock.mockReturnValue(start + LOGIN_CODE_PENDING_FLOW_TTL_MS - 1);
      expect(hasLostLoginCodeChallenge("fan@example.com", session, marker, Date.now())).toBe(true);

      clock.mockReturnValue(start + LOGIN_CODE_PENDING_FLOW_TTL_MS);
      expect(hasLostLoginCodeChallenge("fan@example.com", session, marker, Date.now())).toBe(false);
      const probe = vi.fn(async () => false);
      await recoverLoginCodeChallenge("fan@example.com", probe, session, crypto);
      expect(probe).not.toHaveBeenCalled();
      const next = getOrCreateLoginCodeChallenge("fan@example.com", session, crypto);
      expect(next).not.toBe(original);
      expect(getStoredLoginCodeChallenge("fan@example.com", session)).toBe(next);
    } finally {
      clock.mockRestore();
    }
  });

  it("detects challenge loss when the pending marker survives without the secret", () => {
    const session = storage();
    const marker = storage();
    const now = 1_700_000_000_000;
    rememberPendingLoginCodeFlow("fan@example.com", marker, now);

    expect(hasLostLoginCodeChallenge("fan@example.com", session, marker, now)).toBe(true);

    getOrCreateLoginCodeChallenge("fan@example.com", session, cryptoSource());
    expect(hasLostLoginCodeChallenge("fan@example.com", session, marker, now)).toBe(false);

    clearPendingLoginCodeFlow("fan@example.com", marker, now);
    expect(hasLostLoginCodeChallenge("fan@example.com", session, marker, now)).toBe(false);
  });
  it("restores both generations and replays a lost-response rotation idempotently", () => {
    const session = storage();
    const crypto = cryptoSource();
    const original = getOrCreateLoginCodeChallenge("fan@example.com", session, crypto);
    const replacement = rotateLoginCodeChallenge("fan@example.com", session, crypto, original);
    expect(getLoginCodeRecoveryChallenge("fan@example.com", session)).toBe(original);
    expect(getStoredLoginCodeChallenge("fan@example.com", session)).toBe(replacement);
    expect(rotateLoginCodeChallenge("fan@example.com", session, crypto, original)).toBe(
      replacement,
    );
    expect(crypto.getRandomValues).toHaveBeenCalledTimes(2);
    acknowledgeLoginCodeReplacement("fan@example.com", session);
    expect(getLoginCodeRecoveryChallenge("fan@example.com", session)).toBe(original);
    const next = rotateLoginCodeChallenge("fan@example.com", session, crypto, replacement);
    expect(next).not.toBe(replacement);
    expect(getLoginCodeRecoveryChallenge("fan@example.com", session)).toBe(replacement);
    clearLoginCodeChallenge("fan@example.com", session);
    expect(getLoginCodeRecoveryChallenge("fan@example.com", session)).toBeNull();
  });

  it("retains both duplicated tabs' recovery tuples after uniform accepted responses", async () => {
    const first = storage();
    const second = storage();
    const original = getOrCreateLoginCodeChallenge("fan@example.com", first, cryptoSource());
    second.setItem("auth.login-code-challenge", first.getItem("auth.login-code-challenge")!);
    const firstCrypto = cryptoSource(2);
    const secondCrypto = cryptoSource(3);
    const winner = rotateLoginCodeChallenge("fan@example.com", first, firstCrypto, original);
    const loser = rotateLoginCodeChallenge("fan@example.com", second, secondCrypto, original);
    expect(winner).not.toBe(loser);

    // The server registers only one, but both tabs receive the same accepted.
    for (const session of [first, second]) {
      acknowledgeLoginCodeReplacement("fan@example.com", session);
      expect(getLoginCodeRecoveryChallenge("fan@example.com", session)).toBe(original);
    }
    // Reload/retry reuses the losing proposal without discarding the old tuple.
    const probe = vi.fn(async (challenge: string) => challenge === original);
    await recoverLoginCodeChallenge("fan@example.com", probe, second, secondCrypto);
    expect(probe.mock.calls.map(([challenge]) => challenge)).toEqual([loser, original]);
    expect(getStoredLoginCodeChallenge("fan@example.com", second)).toBe(loser);
    expect(secondCrypto.getRandomValues).toHaveBeenCalledOnce();
    clearLoginCodeChallenge("fan@example.com", first);
    expect(getLoginCodeRecoveryChallenge("fan@example.com", first)).toBeNull();
    expect(getLoginCodeRecoveryChallenge("fan@example.com", second)).toBe(original);
  });

  it("recovers a lost fifth-error response for a second generation after reload", async () => {
    const session = storage();
    const crypto = cryptoSource();
    const original = getOrCreateLoginCodeChallenge("fan@example.com", session, crypto);
    const replacement = rotateLoginCodeChallenge("fan@example.com", session, crypto, original);
    acknowledgeLoginCodeReplacement("fan@example.com", session);
    const reloaded = storage();
    reloaded.setItem("auth.login-code-challenge", session.getItem("auth.login-code-challenge")!);
    // Both generations are exhausted; the current one must win the probe.
    const probe = vi.fn(async (challenge: string) => [original, replacement].includes(challenge));
    await recoverLoginCodeChallenge("fan@example.com", probe, reloaded, crypto);
    expect(probe).toHaveBeenCalledExactlyOnceWith(replacement);
    const next = getStoredLoginCodeChallenge("fan@example.com", reloaded);
    expect(next).not.toBe(replacement);
    expect(next).not.toBe(original);
    expect(getLoginCodeRecoveryChallenge("fan@example.com", reloaded)).toBe(replacement);
    acknowledgeLoginCodeReplacement("fan@example.com", reloaded);
    await recoverLoginCodeChallenge("fan@example.com", probe, reloaded, crypto);
    expect(getStoredLoginCodeChallenge("fan@example.com", reloaded)).toBe(next);
    expect(getLoginCodeRecoveryChallenge("fan@example.com", reloaded)).toBe(replacement);
  });

  it("never replaces stored state when persisting the rotation fails", () => {
    const session = storage();
    const crypto = cryptoSource();
    const original = getOrCreateLoginCodeChallenge("fan@example.com", session, crypto);
    session.setItem.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    expect(() => rotateLoginCodeChallenge("fan@example.com", session, crypto, original)).toThrow();
    expect(getStoredLoginCodeChallenge("fan@example.com", session)).toBe(original);
  });
});
