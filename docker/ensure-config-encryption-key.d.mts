export const CONFIG_ENCRYPTION_KEY_PREFIX: "cek1:";

export function stripSingleTrailingLineEnding(value: string): string;
export function normalizeConfigEncryptionKeyFileContent(content: string): string;
export function validateConfigEncryptionKey(value: unknown): string;
export function validateConfigEncryptionKeyFileValue(value: unknown): string;
export function fsyncDirectory(path: string): void;
export function generateConfigEncryptionKey(
  randomBytesFn?: typeof import("crypto").randomBytes,
): string;
export function readConfigEncryptionKeyTarget(target: string): string;

export function ensureConfigEncryptionKeyFile(
  target: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
    randomBytesFn?: typeof import("crypto").randomBytes;
    fsyncDirectoryFn?: (path: string, stage: "after-link" | "after-unlink") => void;
    linkSyncFn?: typeof import("fs").linkSync;
    log?: (message: string) => void;
  },
): "external" | "loaded" | "generated";
