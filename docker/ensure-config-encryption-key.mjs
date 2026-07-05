import { randomBytes } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

export const CONFIG_ENCRYPTION_KEY_PREFIX = "cek1:";

function invalidConfigEncryptionKeyFile() {
  throw new Error("CONFIG_ENCRYPTION_KEY_FILE is missing or invalid");
}

function invalidConfigEncryptionKey() {
  throw new Error("CONFIG_ENCRYPTION_KEY is missing or invalid");
}

export function stripSingleTrailingLineEnding(value) {
  return value.replace(/\r?\n$/, "");
}

export function normalizeConfigEncryptionKeyFileContent(content) {
  const trimmed = content.trim();
  validateConfigEncryptionKeyFileValue(trimmed);
  // File-backed key reads intentionally match origin/main's `.trim()` semantics.
  // Generated cek1 files contain no surrounding whitespace, so this is identity for them.
  return trimmed;
}

export function validateConfigEncryptionKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    invalidConfigEncryptionKey();
  }
  return value;
}

export function validateConfigEncryptionKeyFileValue(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    invalidConfigEncryptionKeyFile();
  }
  return value;
}

function isErrnoCode(error, code) {
  return error && typeof error === "object" && error.code === code;
}

export function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function generateConfigEncryptionKey(randomBytesFn = randomBytes) {
  return `${CONFIG_ENCRYPTION_KEY_PREFIX}${randomBytesFn(32).toString("base64url")}`;
}

export function readConfigEncryptionKeyTarget(target) {
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new Error("config encryption key file is missing");
    }
    throw new Error("config encryption key file is unreadable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) invalidConfigEncryptionKeyFile();

  let value;
  try {
    value = readFileSync(target, "utf8");
  } catch {
    throw new Error("config encryption key file is unreadable");
  }
  value = normalizeConfigEncryptionKeyFileContent(value);
  chmodSync(target, 0o600);
  return value;
}

export function ensureConfigEncryptionKeyFile(
  target,
  {
    environment = process.env,
    randomBytesFn = randomBytes,
    fsyncDirectoryFn = fsyncDirectory,
    linkSyncFn = linkSync,
    log = console.log,
  } = {},
) {
  if (!target) throw new Error("config encryption key file path is required");

  const external = environment.CONFIG_ENCRYPTION_KEY;
  if (external !== undefined && external.length > 0) {
    validateConfigEncryptionKey(external);
    log("Using externally managed config encryption key");
    return "external";
  }

  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  try {
    readConfigEncryptionKeyTarget(target);
    log("Loaded persistent config encryption key");
    return "loaded";
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "config encryption key file is missing") {
      throw error;
    }
  }

  try {
    // Publish only after the complete key has been written and fsynced. linkSync is
    // the atomic winner election; concurrent losers read the winner's complete file.
    const temporary = `${target}.tmp-${process.pid}-${randomBytesFn(8).toString("hex")}`;
    let descriptor;
    let temporaryCreated = false;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      temporaryCreated = true;
      writeFileSync(descriptor, generateConfigEncryptionKey(randomBytesFn), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;

      try {
        linkSyncFn(temporary, target);
        // Persist the newly published target directory entry before reporting success.
        fsyncDirectoryFn(parent, "after-link");
        log("Generated persistent config encryption key");
      } catch (linkError) {
        if (!isErrnoCode(linkError, "EEXIST")) throw linkError;
        readConfigEncryptionKeyTarget(target);
        // A concurrent winner may die after linkSync and before its own directory fsync.
        // The loser fsyncs the parent after reading the published key to persist it too.
        fsyncDirectoryFn(parent, "after-link");
        log("Loaded persistent config encryption key");
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temporaryCreated) {
        try {
          unlinkSync(temporary);
          // Persist deletion of the temporary directory entry as well.
          fsyncDirectoryFn(parent, "after-unlink");
        } catch (unlinkError) {
          if (!isErrnoCode(unlinkError, "ENOENT")) throw unlinkError;
        }
      }
    }
    return "generated";
  } catch {
    // A successfully linked target is intentionally retained. A later startup validates
    // and reuses it rather than generating a different value.
    throw new Error("unable to create persistent config encryption key");
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  ensureConfigEncryptionKeyFile(process.argv[2]);
}
