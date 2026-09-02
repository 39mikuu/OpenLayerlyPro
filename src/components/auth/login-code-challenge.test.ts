import { describe, expect, it, vi } from "vitest";

import {
  clearLoginCodeChallenge,
  clearPendingLoginCodeFlow,
  getOrCreateLoginCodeChallenge,
  getPendingLoginCodeFlow,
  getStoredLoginCodeChallenge,
  hasLostLoginCodeChallenge,
  LOGIN_CODE_PENDING_FLOW_TTL_MS,
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
});
