import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));

import {
  getMagicLinkKeys,
  resetMagicLinkKeyCacheForTests,
  tryGetMagicLinkKeys,
} from "./magic-link-key";

const VALID_SECRET = "0123456789abcdef0123456789abcdef";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    MAGIC_LINK_KEY_ID: undefined,
    MAGIC_LINK_SECRET: undefined,
    MAGIC_LINK_SECRET_FILE: undefined,
    MAGIC_LINK_PREVIOUS_KEY_ID: undefined,
    MAGIC_LINK_PREVIOUS_SECRET: undefined,
    MAGIC_LINK_PREVIOUS_SECRET_FILE: undefined,
    ...overrides,
  };
}

describe("magic link keyring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMagicLinkKeyCacheForTests();
  });

  afterEach(() => {
    resetMagicLinkKeyCacheForTests();
  });

  it("returns null when fully unconfigured and getMagicLinkKeys fails closed", () => {
    mocks.getEnv.mockReturnValue(env());
    expect(tryGetMagicLinkKeys()).toBeNull();
    expect(() => getMagicLinkKeys()).toThrow("MAGIC_LINK_SECRET");
  });

  it("resolves a current-only keyring", () => {
    mocks.getEnv.mockReturnValue(
      env({ MAGIC_LINK_KEY_ID: "current", MAGIC_LINK_SECRET: VALID_SECRET }),
    );
    expect(tryGetMagicLinkKeys()).toEqual({
      current: { keyId: "current", secret: VALID_SECRET },
      previous: null,
    });
  });

  it("resolves current+previous for rotation and records both key ids", () => {
    mocks.getEnv.mockReturnValue(
      env({
        MAGIC_LINK_KEY_ID: "k2",
        MAGIC_LINK_SECRET: VALID_SECRET,
        MAGIC_LINK_PREVIOUS_KEY_ID: "k1",
        MAGIC_LINK_PREVIOUS_SECRET: `${VALID_SECRET}-old`,
      }),
    );
    expect(getMagicLinkKeys()).toEqual({
      current: { keyId: "k2", secret: VALID_SECRET },
      previous: { keyId: "k1", secret: `${VALID_SECRET}-old` },
    });
  });

  it.each([
    ["previous key id without secret", { MAGIC_LINK_PREVIOUS_KEY_ID: "k1" }],
    ["previous secret without key id", { MAGIC_LINK_PREVIOUS_SECRET: VALID_SECRET }],
    ["key id missing while secret present", { MAGIC_LINK_SECRET: VALID_SECRET }],
    [
      "duplicate current/previous key ids",
      {
        MAGIC_LINK_KEY_ID: "same",
        MAGIC_LINK_SECRET: VALID_SECRET,
        MAGIC_LINK_PREVIOUS_KEY_ID: "same",
        MAGIC_LINK_PREVIOUS_SECRET: `${VALID_SECRET}-old`,
      },
    ],
    ["short current secret", { MAGIC_LINK_KEY_ID: "current", MAGIC_LINK_SECRET: "too-short" }],
  ])("fails closed on partial or invalid config: %s", (_label, overrides) => {
    mocks.getEnv.mockReturnValue(env(overrides));
    expect(() => tryGetMagicLinkKeys()).toThrow();
  });
});
