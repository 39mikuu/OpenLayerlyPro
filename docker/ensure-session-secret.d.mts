export const MIN_SESSION_SECRET_LENGTH: number;

export function stripSingleTrailingLineEnding(value: string): string;
export function validateStrongSessionSecret(value: unknown): string;
export function sessionSecretFingerprint(value: unknown): string;
export function fsyncDirectory(path: string): void;
export function readSessionSecretTarget(
  target: string,
  options?: { afterValidateHook?: () => void },
): string;

export function ensureSessionSecretFile(
  target: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
    randomBytesFn?: typeof import("crypto").randomBytes;
    fsyncDirectoryFn?: (path: string, stage: "after-link" | "after-unlink") => void;
    log?: (message: string) => void;
    afterValidateHook?: () => void;
  },
): "external" | "loaded" | "generated";
