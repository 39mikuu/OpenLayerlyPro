import {
  isLoginCodeComplete,
  normalizeEmail,
  sanitizeLoginCodeInput,
} from "@/modules/auth/input-policy";

export type FanLoginFlowState = {
  email: string;
  requestedEmail: string | null;
  code: string;
  codeSent: boolean;
};

export const INITIAL_FAN_LOGIN_FLOW: FanLoginFlowState = {
  email: "",
  requestedEmail: null,
  code: "",
  codeSent: false,
};

export function changeFanLoginEmail(state: FanLoginFlowState, email: string): FanLoginFlowState {
  return {
    ...state,
    email,
    requestedEmail: null,
    codeSent: false,
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

export function resetFanLoginRequestedEmail(state: FanLoginFlowState): FanLoginFlowState {
  return {
    ...state,
    requestedEmail: null,
    codeSent: false,
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
