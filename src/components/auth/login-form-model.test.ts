import { describe, expect, it } from "vitest";

import {
  acceptFanLoginCodeRequest,
  canSubmitFanLoginCode,
  changeFanLoginCode,
  changeFanLoginEmail,
  INITIAL_FAN_LOGIN_FLOW,
  resetFanLoginRequestedEmail,
} from "./login-form-model";

describe("fan login form flow", () => {
  const codePattern = /^[0-9A-HJKMNP-TV-Z]{16}$/;

  it("normalizes lowercase and whitespace-padded pasted codes before completeness checks", () => {
    const accepted = acceptFanLoginCodeRequest(INITIAL_FAN_LOGIN_FLOW, " Fan@Example.com ");
    const withCode = changeFanLoginCode(accepted, "  abcd1234efgh5678  ");

    expect(accepted.requestedEmail).toBe("fan@example.com");
    expect(withCode.code).toBe("ABCD1234EFGH5678");
    expect(canSubmitFanLoginCode(withCode, 16, codePattern)).toBe(true);
  });

  it("resets the requested email, code state, and submit guard when changing email", () => {
    const accepted = changeFanLoginCode(
      acceptFanLoginCodeRequest(INITIAL_FAN_LOGIN_FLOW, "first@example.com"),
      "ABCD1234EFGH5678",
    );
    const changed = changeFanLoginEmail(accepted, "second@example.com");

    expect(changed).toMatchObject({
      email: "second@example.com",
      requestedEmail: null,
      codeSent: false,
      code: "",
    });
    expect(canSubmitFanLoginCode(changed, 16, codePattern)).toBe(false);
  });

  it("clears an old code after every accepted resend while retaining it on request failure", () => {
    const withOldCode = changeFanLoginCode(
      acceptFanLoginCodeRequest(INITIAL_FAN_LOGIN_FLOW, "fan@example.com"),
      "ABCD1234EFGH5678",
    );

    // A failed request does not apply an accepted transition, so the old code remains.
    expect(withOldCode.code).toBe("ABCD1234EFGH5678");

    const resent = acceptFanLoginCodeRequest(withOldCode, withOldCode.requestedEmail!);
    expect(resent.code).toBe("");
    expect(canSubmitFanLoginCode(resent, 16, codePattern)).toBe(false);
  });

  it("requires a requested email and exactly 16 valid normalized characters", () => {
    const accepted = acceptFanLoginCodeRequest(INITIAL_FAN_LOGIN_FLOW, "fan@example.com");
    expect(
      canSubmitFanLoginCode(changeFanLoginCode(accepted, "ABCD1234EFGH567"), 16, codePattern),
    ).toBe(false);
    expect(
      canSubmitFanLoginCode(changeFanLoginCode(accepted, "ABCD1234EFGH567I"), 16, codePattern),
    ).toBe(false);
    expect(
      canSubmitFanLoginCode(changeFanLoginCode(accepted, "ABCD1234EFGH5678"), 16, codePattern),
    ).toBe(true);
    expect(
      canSubmitFanLoginCode(
        resetFanLoginRequestedEmail(changeFanLoginCode(accepted, "ABCD1234EFGH5678")),
        16,
        codePattern,
      ),
    ).toBe(false);
  });
});
