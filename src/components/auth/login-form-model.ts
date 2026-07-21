import {
  isLoginCodeComplete,
  normalizeEmail,
  sanitizeLoginCodeInput,
} from "@/modules/auth/input-policy";

export const OAUTH_ERROR_CODES = [
  "failed",
  "denied",
  "state",
  "email",
  "bind",
  "config",
  "provider",
  "callback",
  "start",
  "rate_limited",
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export function normalizeOAuthErrorCode(value: string | null | undefined): OAuthErrorCode | null {
  if (!value) return null;
  return (OAUTH_ERROR_CODES as readonly string[]).includes(value)
    ? (value as OAuthErrorCode)
    : "failed";
}

export type FanLoginFlowState = {
  email: string;
  requestedEmail: string | null;
  code: string;
  codeSent: boolean;
  linkSent: boolean;
};

export const INITIAL_FAN_LOGIN_FLOW: FanLoginFlowState = {
  email: "",
  requestedEmail: null,
  code: "",
  codeSent: false,
  linkSent: false,
};

export function changeFanLoginEmail(state: FanLoginFlowState, email: string): FanLoginFlowState {
  return {
    ...state,
    email,
    requestedEmail: null,
    codeSent: false,
    linkSent: false,
    code: "",
  };
}

export function acceptFanLoginCodeRequest(
  state: FanLoginFlowState,
  targetEmail = state.email,
): FanLoginFlowState {
  const requestedEmail = normalizeEmail(targetEmail);
  return {
    ...state,
    email: requestedEmail,
    requestedEmail,
    codeSent: true,
    code: "",
  };
}

export function acceptFanLoginLinkRequest(
  state: FanLoginFlowState,
  targetEmail = state.email,
): FanLoginFlowState {
  const requestedEmail = normalizeEmail(targetEmail);
  return {
    ...state,
    email: requestedEmail,
    requestedEmail,
    linkSent: true,
  };
}

export function resetFanLoginRequestedEmail(state: FanLoginFlowState): FanLoginFlowState {
  return {
    ...state,
    requestedEmail: null,
    codeSent: false,
    linkSent: false,
    code: "",
  };
}

export function changeFanLoginCode(state: FanLoginFlowState, rawCode: string): FanLoginFlowState {
  return { ...state, code: sanitizeLoginCodeInput(rawCode) };
}

export function canSubmitFanLoginCode(
  state: FanLoginFlowState,
  length: number,
  pattern: RegExp,
): boolean {
  return (
    state.requestedEmail !== null &&
    state.codeSent &&
    isLoginCodeComplete(state.code, length, pattern)
  );
}
