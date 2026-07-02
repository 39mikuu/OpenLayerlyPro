import { createHash, randomBytes } from "crypto";
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

export const MIN_SESSION_SECRET_LENGTH = 32;

function invalidSecret() {
  throw new Error("SESSION_SECRET is missing or invalid");
}

export function stripSingleTrailingLineEnding(value) {
  return value.replace(/\r?\n$/, "");
}

export function validateStrongSessionSecret(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value === "change-me" ||
    value.length < MIN_SESSION_SECRET_LENGTH
  ) {
    invalidSecret();
  }
  return value;
}

export function sessionSecretFingerprint(value) {
  return createHash("sha256").update(validateStrongSessionSecret(value)).digest("hex");
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

export function readSessionSecretTarget(target) {
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new Error("session secret file is missing");
    }
    throw new Error("session secret file is unreadable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) invalidSecret();

  let value;
  try {
    value = stripSingleTrailingLineEnding(readFileSync(target, "utf8"));
  } catch {
    throw new Error("session secret file is unreadable");
  }
  validateStrongSessionSecret(value);
  chmodSync(target, 0o600);
  return value;
}

export function ensureSessionSecretFile(
  target,
  {
    environment = process.env,
    randomBytesFn = randomBytes,
    fsyncDirectoryFn = fsyncDirectory,
    log = console.log,
  } = {},
) {
  if (!target) throw new Error("session secret file path is required");

  const external = environment.SESSION_SECRET;
  if (external !== undefined && external.length > 0) {
    validateStrongSessionSecret(external);
    log("Using externally managed session secret");
    return "external";
  }

  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  try {
    readSessionSecretTarget(target);
    log("Loaded persistent session secret");
    return "loaded";
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "session secret file is missing") {
      throw error;
    }
  }

  try {
    // Publish only after the complete secret has been written and fsynced. linkSync is
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
      writeFileSync(descriptor, randomBytesFn(32).toString("base64url"), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;

      try {
        linkSync(temporary, target);
        // Persist the newly published target directory entry before reporting success.
        fsyncDirectoryFn(parent, "after-link");
        log("Generated persistent session secret");
      } catch (linkError) {
        if (!isErrnoCode(linkError, "EEXIST")) throw linkError;
        readSessionSecretTarget(target);
        log("Loaded persistent session secret");
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
    throw new Error("unable to create persistent session secret");
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  ensureSessionSecretFile(process.argv[2]);
}
