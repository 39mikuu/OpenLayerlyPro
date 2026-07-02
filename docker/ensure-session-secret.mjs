import { randomBytes } from "crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

const target = process.argv[2];
if (!target) throw new Error("session secret file path is required");

function fail() {
  throw new Error("SESSION_SECRET is missing or invalid");
}

function validate(value) {
  if (!value || value.trim().length === 0 || value === "change-me" || value.length < 32) fail();
  return value;
}

function readTarget() {
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error("session secret file is missing");
    }
    throw new Error("session secret file is unreadable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail();

  let value;
  try {
    value = readFileSync(target, "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new Error("session secret file is unreadable");
  }
  validate(value);
  chmodSync(target, 0o600);
  return value;
}

if (process.env.SESSION_SECRET) {
  validate(process.env.SESSION_SECRET);
  console.log("Using externally managed session secret");
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

try {
  readTarget();
  console.log("Loaded persistent session secret");
} catch (error) {
  if (error instanceof Error && error.message !== "session secret file is missing") throw error;
  try {
    // Publish only after the complete secret has been written and fsynced. linkSync is
    // the atomic winner election; concurrent losers read the winner's complete file.
    const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    let descriptor;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(descriptor, randomBytes(32).toString("base64url"), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, target);
        console.log("Generated persistent session secret");
      } catch (linkError) {
        if (!(linkError && typeof linkError === "object" && linkError.code === "EEXIST")) {
          throw linkError;
        }
        readTarget();
        console.log("Loaded persistent session secret");
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch (unlinkError) {
        if (!(unlinkError && typeof unlinkError === "object" && unlinkError.code === "ENOENT")) {
          throw unlinkError;
        }
      }
    }
  } catch {
    throw new Error("unable to create persistent session secret");
  }
}
