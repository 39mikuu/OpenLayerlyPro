import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const original = {
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
  CONFIG_ENCRYPTION_KEY_FILE: process.env.CONFIG_ENCRYPTION_KEY_FILE,
};

async function loadConfigKey() {
  vi.resetModules();
  return import("./config-key");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("config encryption key resolver", () => {
  it("prefers the environment key", async () => {
    process.env.CONFIG_ENCRYPTION_KEY = "environment-config-key";
    process.env.CONFIG_ENCRYPTION_KEY_FILE = "/does/not/exist";
    const { getConfigEncryptionKey } = await loadConfigKey();
    expect(getConfigEncryptionKey()).toBe("environment-config-key");
  });

  it("reads a legacy file value verbatim and removes only one trailing newline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-config-key-"));
    const file = path.join(dir, "key");
    writeFileSync(file, "legacy-config-key\n", { mode: 0o600 });
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    const { getConfigEncryptionKey } = await loadConfigKey();
    expect(getConfigEncryptionKey()).toBe("legacy-config-key");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a regular file through the descriptor-bound path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-config-key-"));
    const file = path.join(dir, "key");
    writeFileSync(file, "descriptor-bound-config-key", { mode: 0o600 });
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    const { getConfigEncryptionKey } = await loadConfigKey();
    expect(getConfigEncryptionKey()).toBe("descriptor-bound-config-key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads padded legacy key files with origin/main trim semantics", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-config-key-"));
    const file = path.join(dir, "key");
    writeFileSync(file, "  legacy-key-value \n\n", { mode: 0o600 });
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    const { getConfigEncryptionKey } = await loadConfigKey();
    expect(getConfigEncryptionKey()).toBe("legacy-key-value");
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["cek1:abc\n\n", "cek1:abc"],
    [" cek1:abc", "cek1:abc"],
    ["  legacy \n\n", "legacy"],
    ["key\r\n\r\n", "key"],
  ])("reads %j with origin/main trim semantics", async (value, expected) => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-config-key-"));
    const file = path.join(dir, "key");
    writeFileSync(file, value, { mode: 0o600 });
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    const { getConfigEncryptionKey } = await loadConfigKey();
    expect(getConfigEncryptionKey()).toBe(expected);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null only when no key source is configured", async () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    delete process.env.CONFIG_ENCRYPTION_KEY_FILE;
    const { getConfigEncryptionKey, isConfigEncryptionKeyConfigured } = await loadConfigKey();
    expect(isConfigEncryptionKeyConfigured()).toBe(false);
    expect(getConfigEncryptionKey()).toBeNull();
  });

  it.each(["", "    "])("rejects an invalid configured environment key: %s", async (value) => {
    process.env.CONFIG_ENCRYPTION_KEY = value;
    delete process.env.CONFIG_ENCRYPTION_KEY_FILE;
    const { getConfigEncryptionKey } = await loadConfigKey();
    if (value === "") expect(getConfigEncryptionKey()).toBeNull();
    else
      expect(() => getConfigEncryptionKey()).toThrow("CONFIG_ENCRYPTION_KEY is missing or invalid");
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["whitespace", "      "],
  ])("fails loudly for a configured-but-invalid file: %s", async (_label, value) => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-config-key-"));
    const file = path.join(dir, "key");
    if (value !== null) writeFileSync(file, value, { mode: 0o600 });
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    const { getConfigEncryptionKey } = await loadConfigKey();
    expect(() => getConfigEncryptionKey()).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects symlink and directory targets", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-config-key-"));
    const directoryTarget = path.join(dir, "directory");
    mkdirSync(directoryTarget);
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_FILE = directoryTarget;
    let configKeyModule = await loadConfigKey();
    expect(() => configKeyModule.getConfigEncryptionKey()).toThrow(
      "CONFIG_ENCRYPTION_KEY_FILE is missing or invalid",
    );

    const linked = path.join(dir, "linked");
    const symlink = path.join(dir, "symlink");
    writeFileSync(linked, "legacy-config-key", { mode: 0o600 });
    symlinkSync(linked, symlink);
    process.env.CONFIG_ENCRYPTION_KEY_FILE = symlink;
    configKeyModule = await loadConfigKey();
    expect(() => configKeyModule.getConfigEncryptionKey()).toThrow(
      "CONFIG_ENCRYPTION_KEY_FILE is missing or invalid",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a FIFO target without blocking", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-config-key-"));
    const fifo = path.join(dir, "fifo");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch (error) {
      // Some sandboxes disallow mknod/mkfifo even on Linux. Keep the real FIFO
      // regression active where permitted, and skip only when fixture creation is blocked.
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        console.warn("Skipping FIFO rejection regression: mkfifo is not permitted here");
        rmSync(dir, { recursive: true, force: true });
        return;
      }
      throw error;
    }
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_FILE = fifo;
    const configKeyModule = await loadConfigKey();
    expect(() => configKeyModule.getConfigEncryptionKey()).toThrow(
      "CONFIG_ENCRYPTION_KEY_FILE is missing or invalid",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not permanently cache configured file errors", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "olp-config-key-"));
    const file = path.join(dir, "key");
    writeFileSync(file, "", { mode: 0o600 });
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    const { getConfigEncryptionKey } = await loadConfigKey();
    expect(() => getConfigEncryptionKey()).toThrow();
    writeFileSync(file, "fixed-config-key", { mode: 0o600 });
    expect(getConfigEncryptionKey()).toBe("fixed-config-key");
    rmSync(dir, { recursive: true, force: true });
  });
});
