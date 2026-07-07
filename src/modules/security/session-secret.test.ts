import { execFile, execFileSync } from "child_process";
import { createHmac } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SECRET_FILE_OPEN_FLAGS } from "./session-secret";

const original = {
  NODE_ENV: process.env.NODE_ENV,
  SESSION_SECRET: process.env.SESSION_SECRET,
  SESSION_SECRET_FILE: process.env.SESSION_SECRET_FILE,
};

async function loadSecret() {
  vi.resetModules();
  return import("./session-secret");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("session secret resolver", () => {
  it("prefers the environment and preserves HMAC compatibility", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_SECRET = "environment-session-secret-0123456789";
    process.env.SESSION_SECRET_FILE = "/does/not/exist";
    const { getSessionSecret } = await loadSecret();
    expect(getSessionSecret()).toBe(process.env.SESSION_SECRET);

    const { hmacSha256, hmacSha256WithPurpose } = await import("@/lib/crypto");
    expect(hmacSha256("value")).toBe(
      createHmac("sha256", process.env.SESSION_SECRET).update("value").digest("hex"),
    );
    expect(hmacSha256WithPurpose("login-code", "value")).toBe(
      createHmac("sha256", process.env.SESSION_SECRET)
        .update("login-code")
        .update("\0")
        .update("value")
        .digest("hex"),
    );
  });

  it("reads a strong file value and removes one trailing newline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-session-secret-"));
    const file = path.join(dir, "secret");
    writeFileSync(file, "file-session-secret-0123456789012345\n", { mode: 0o600 });
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    process.env.SESSION_SECRET_FILE = file;
    const { getSessionSecret } = await loadSecret();
    expect(getSessionSecret()).toBe("file-session-secret-0123456789012345");
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses a deterministic non-production fallback", async () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET_FILE;
    const { getSessionSecret } = await loadSecret();
    expect(getSessionSecret()).toBe(getSessionSecret());
    expect(getSessionSecret().length).toBeGreaterThanOrEqual(32);
  });

  it("keeps the auth-task v1 ciphertext compatible across process caches", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_SECRET = "auth-task-session-secret-01234567890123";
    delete process.env.SESSION_SECRET_FILE;
    vi.resetModules();
    const firstCrypto = await import("@/lib/crypto");
    const ciphertext = firstCrypto.encryptAuthTaskSecret("login-code");
    expect(ciphertext.startsWith("v1:")).toBe(true);

    vi.resetModules();
    const secondCrypto = await import("@/lib/crypto");
    expect(secondCrypto.decryptAuthTaskSecret(ciphertext)).toBe("login-code");

    process.env.SESSION_SECRET = "different-session-secret-0123456789012";
    vi.resetModules();
    const wrongCrypto = await import("@/lib/crypto");
    expect(() => wrongCrypto.decryptAuthTaskSecret(ciphertext)).toThrow();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["short", "short"],
    ["placeholder", "change-me"],
    ["whitespace", " ".repeat(32)],
  ])("fails safely for a %s production secret", async (_label, value) => {
    vi.stubEnv("NODE_ENV", "production");
    if (value === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = value;
    delete process.env.SESSION_SECRET_FILE;
    const { getSessionSecret } = await loadSecret();
    expect(() => getSessionSecret()).toThrow("SESSION_SECRET is missing or invalid");
    try {
      getSessionSecret();
    } catch (error) {
      if (value) expect(String(error)).not.toContain(value);
    }
  });

  it.each(["", "short", "change-me"])(
    "rejects an invalid file without leaking it",
    async (value) => {
      const dir = mkdtempSync(path.join(tmpdir(), "olp-session-secret-"));
      const file = path.join(dir, "secret");
      writeFileSync(file, value);
      vi.stubEnv("NODE_ENV", "production");
      delete process.env.SESSION_SECRET;
      process.env.SESSION_SECRET_FILE = file;
      const { getSessionSecret } = await loadSecret();
      expect(() => getSessionSecret()).toThrow();
      try {
        getSessionSecret();
      } catch (error) {
        expect(String(error)).not.toContain(value || "empty");
      }
      rmSync(dir, { recursive: true, force: true });
    },
  );

  it("fails safely for an unreadable or missing file and caches a resolved value", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-session-secret-"));
    const file = path.join(dir, "secret");
    writeFileSync(file, "cached-session-secret-012345678901234", { mode: 0o600 });
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    process.env.SESSION_SECRET_FILE = file;
    const { getSessionSecret } = await loadSecret();
    const first = getSessionSecret();
    writeFileSync(file, "replacement-session-secret-01234567890");
    expect(getSessionSecret()).toBe(first);

    vi.resetModules();
    process.env.SESSION_SECRET_FILE = path.join(dir, "missing");
    const fresh = await import("./session-secret");
    expect(() => fresh.getSessionSecret()).toThrow("session secret file is unreadable");

    vi.resetModules();
    const unreadable = path.join(dir, "directory");
    mkdirSync(unreadable);
    process.env.SESSION_SECRET_FILE = unreadable;
    const unreadableModule = await import("./session-secret");
    expect(() => unreadableModule.getSessionSecret()).toThrow("session secret file is unreadable");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a symlink session secret target without reading through it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-session-secret-"));
    const attacker = path.join(dir, "attacker-secret");
    const file = path.join(dir, "secret-link");
    const attackerSecret = "attacker-controlled-session-secret-012345678901234";
    writeFileSync(attacker, attackerSecret, { mode: 0o600 });
    symlinkSync(attacker, file);

    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    process.env.SESSION_SECRET_FILE = file;
    const { getSessionSecret } = await loadSecret();

    expect(() => getSessionSecret()).toThrow("session secret file is unreadable");
    expect(readFileSync(attacker, "utf8")).toBe(attackerSecret);
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens a FIFO using the production open flags without blocking", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-session-secret-"));
    const file = path.join(dir, "secret-fifo");
    execFileSync("mkfifo", [file]);

    // session-secret.ts imports @/lib/env, so spawning the real module needs this
    // project's path-alias setup; calling the sync reader in-process could hang the
    // worker forever if O_NONBLOCK ever regressed. Instead, pass the actual exported
    // SECRET_FILE_OPEN_FLAGS value into a killable child process, so this test fails
    // on the real flags rather than a copy that could silently drift from them.
    const child = execFile(process.execPath, [
      "-e",
      `const fs = require("fs");
const descriptor = fs.openSync(process.argv[1], Number(process.argv[2]));
fs.closeSync(descriptor);`,
      file,
      String(SECRET_FILE_OPEN_FLAGS),
    ]);

    const outcome = await Promise.race([
      new Promise<"exited">((resolve) => child.on("exit", () => resolve("exited"))),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]);

    if (outcome === "timeout") child.kill("SIGKILL");

    expect(outcome).toBe("exited");
    expect(child.exitCode).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
