import { describe, expect, it, vi } from "vitest";

import {
  clearLoginCodeChallenge,
  getOrCreateLoginCodeChallenge,
  getStoredLoginCodeChallenge,
} from "./login-code-challenge";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

describe("login code browser challenge", () => {
  it("generates 32 random bytes and reuses them for normalized-email resends", () => {
    const session = storage();
    const cryptoSource = {
      getRandomValues: vi.fn((bytes: Uint8Array) => {
        bytes.forEach((_value, index) => {
          bytes[index] = index;
        });
        return bytes;
      }),
    };

    const first = getOrCreateLoginCodeChallenge(" Fan@Example.com ", session, cryptoSource);
    const resend = getOrCreateLoginCodeChallenge("fan@example.com", session, cryptoSource);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resend).toBe(first);
    expect(cryptoSource.getRandomValues).toHaveBeenCalledOnce();
    expect(cryptoSource.getRandomValues.mock.calls[0]?.[0]).toHaveLength(32);
  });

  it("rotates on email change and clears only the matching flow", () => {
    const session = storage();
    let fill = 1;
    const cryptoSource = {
      getRandomValues: vi.fn((bytes: Uint8Array) => {
        bytes.fill(fill++);
        return bytes;
      }),
    };

    const first = getOrCreateLoginCodeChallenge("first@example.com", session, cryptoSource);
    const second = getOrCreateLoginCodeChallenge("second@example.com", session, cryptoSource);

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
});
