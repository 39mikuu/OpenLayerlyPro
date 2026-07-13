import { randomBytes } from "crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

export const MIN_NOTIFICATION_SECRET_LENGTH = 32;

function invalidSecret(label) {
  throw new Error(`${label} is missing or invalid`);
}

function isErrnoCode(error, code) {
  return error && typeof error === "object" && error.code === code;
}

export function validateNotificationSecret(value, label) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    trimmed.length < MIN_NOTIFICATION_SECRET_LENGTH ||
    trimmed === "change-me"
  ) {
    invalidSecret(label);
  }
  return trimmed;
}

export function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function readNotificationSecretTarget(target, label) {
  let descriptor;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) throw new Error(`${label} file is missing`);
    if (isErrnoCode(error, "ELOOP")) invalidSecret(label);
    throw new Error(`${label} file is unreadable`);
  }

  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) invalidSecret(label);
    const value = readFileSync(descriptor, "utf8").replace(/\r?\n$/, "");
    validateNotificationSecret(value, label);
    fchmodSync(descriptor, 0o600);
    return value;
  } finally {
    closeSync(descriptor);
  }
}

export function ensureNotificationSecretFile(
  target,
  {
    envName,
    label,
    environment = process.env,
    randomBytesFn = randomBytes,
    fsyncDirectoryFn = fsyncDirectory,
    log = console.log,
  },
) {
  if (!target) throw new Error(`${label} file path is required`);

  const external = environment[envName];
  if (external !== undefined && external.length > 0) {
    validateNotificationSecret(external, envName);
    log(`Using externally managed ${label}`);
    return "external";
  }

  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  try {
    readNotificationSecretTarget(target, label);
    log(`Loaded persistent ${label}`);
    return "loaded";
  } catch (error) {
    if (!(error instanceof Error) || error.message !== `${label} file is missing`) throw error;
  }

  try {
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
        fsyncDirectoryFn(parent, "after-link");
        log(`Generated persistent ${label}`);
      } catch (linkError) {
        if (!isErrnoCode(linkError, "EEXIST")) throw linkError;
        readNotificationSecretTarget(target, label);
        fsyncDirectoryFn(parent, "after-link");
        log(`Loaded persistent ${label}`);
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temporaryCreated) {
        try {
          unlinkSync(temporary);
          fsyncDirectoryFn(parent, "after-unlink");
        } catch (unlinkError) {
          if (!isErrnoCode(unlinkError, "ENOENT")) throw unlinkError;
        }
      }
    }
    return "generated";
  } catch {
    throw new Error(`unable to create persistent ${label}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  ensureNotificationSecretFile(process.argv[2], {
    envName: process.argv[3],
    label: process.argv[4],
  });
}
