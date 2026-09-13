import { describe, expect, it } from "vitest";

import {
  acceptFanLoginCodeRequest,
  acceptFanLoginLinkRequest,
  canSubmitFanLoginCode,
  changeFanLoginCode,
  changeFanLoginEmail,
  INITIAL_FAN_LOGIN_FLOW,
  normalizeOAuthErrorCode,
  resetFanLoginRequestedEmail,
} from "./login-form-model";

describe("fan login form flow", () => {
  const codePattern = /^[0-9]{6}$/;

  it("allowlists OAuth error codes and falls unknown values back to failed", () => {
    expect(normalizeOAuthErrorCode("denied")).toBe("denied");
    expect(normalizeOAuthErrorCode("state")).toBe("state");
    expect(normalizeOAuthErrorCode("unknown-provider-value")).toBe("failed");
    expect(normalizeOAuthErrorCode(null)).toBeNull();
  });

  it("preserves leading zeroes in six-digit pasted codes", () => {
    const accepted = acceptFanLoginCodeRequest(INITIAL_FAN_LOGIN_FLOW, " Fan@Example.com ");
    const withCode = changeFanLoginCode(accepted, " 012345 ");

    expect(accepted.requestedEmail).toBe("fan@example.com");
    expect(withCode.code).toBe("012345");
    expect(canSubmitFanLoginCode(withCode, 6, codePattern)).toBe(true);
  });

  it("resets the requested email, code state, and submit guard when changing email", () => {
    const accepted = changeFanLoginCode(
      acceptFanLoginCodeRequest(INITIAL_FAN_LOGIN_FLOW, "first@example.com"),
      "123456",
    );
    const changed = changeFanLoginEmail(accepted, "second@example.com");

    expect(changed).toMatchObject({
      email: "second@example.com",
      requestedEmail: null,
      codeSent: false,
      code: "",
    });
    expect(canSubmitFanLoginCode(changed, 6, codePattern)).toBe(false);
  });

  it("clears an old code after every accepted resend while retaining it on request failure", () => {
    const withOldCode = changeFanLoginCode(
      acceptFanLoginCodeRequest(INITIAL_FAN_LOGIN_FLOW, "fan@example.com"),
      "123456",
    );

    // A failed request does not apply an accepted transition, so the old code remains.
    expect(withOldCode.code).toBe("123456");

    const resent = acceptFanLoginCodeRequest(withOldCode, withOldCode.requestedEmail!);
    expect(resent.code).toBe("");
    expect(canSubmitFanLoginCode(resent, 6, codePattern)).toBe(false);
  });

  it("tracks magic link sends independently of the code flow and resets with it", () => {
    const linkSent = acceptFanLoginLinkRequest(INITIAL_FAN_LOGIN_FLOW, " Fan@Example.com ");
    expect(linkSent).toMatchObject({
      email: "fan@example.com",
      requestedEmail: "fan@example.com",
      linkSent: true,
      codeSent: false,
    });

    // Falling back to a code afterwards keeps the link-sent state.
    const alsoCode = acceptFanLoginCodeRequest(linkSent);
    expect(alsoCode).toMatchObject({ linkSent: true, codeSent: true });

    expect(changeFanLoginEmail(alsoCode, "second@example.com")).toMatchObject({
      linkSent: false,
      codeSent: false,
      requestedEmail: null,
    });
    expect(resetFanLoginRequestedEmail(alsoCode)).toMatchObject({
      linkSent: false,
      codeSent: false,
    });
  });

  it("requires a requested email and a complete six-digit or legacy candidate", () => {
    const accepted = acceptFanLoginCodeRequest(INITIAL_FAN_LOGIN_FLOW, "fan@example.com");
    expect(canSubmitFanLoginCode(changeFanLoginCode(accepted, "12345"), 6, codePattern)).toBe(
      false,
    );
    expect(canSubmitFanLoginCode(changeFanLoginCode(accepted, "12345A"), 6, codePattern)).toBe(
      false,
    );
    expect(canSubmitFanLoginCode(changeFanLoginCode(accepted, "123456"), 6, codePattern)).toBe(
      true,
    );
    expect(
      canSubmitFanLoginCode(changeFanLoginCode(accepted, "ABCD1234EFGH5678"), 6, codePattern),
    ).toBe(true);
    expect(
      canSubmitFanLoginCode(changeFanLoginCode(accepted, "1".repeat(64)), 6, codePattern),
    ).toBe(true);
    expect(
      canSubmitFanLoginCode(
        resetFanLoginRequestedEmail(changeFanLoginCode(accepted, "123456")),
        6,
        codePattern,
      ),
    ).toBe(false);
  });
});
