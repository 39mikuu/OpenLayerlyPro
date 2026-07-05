import { execFile, execFileSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIG_ENCRYPTION_KEY_PREFIX,
  ensureConfigEncryptionKeyFile,
  fsyncDirectory,
} from "../../../docker/ensure-config-encryption-key.mjs";

const execFileAsync = promisify(execFile);
const script = path.resolve("docker/ensure-config-encryption-key.mjs");
const directories: string[] = [];

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "olp-config-encryption-key-"));
  directories.push(dir);
  return { dir, file: path.join(dir, "config-encryption-key") };
}

async function run(file: string, key?: string) {
  return execFileAsync(process.execPath, [script, file], {
    env: { ...process.env, CONFIG_ENCRYPTION_KEY: key ?? "" },
  });
}

function fileEnvironment() {
  return { ...process.env, CONFIG_ENCRYPTION_KEY: "" };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistent config encryption key creation", () => {
  it("generates a cek1 key once with mode 0600 and reuses the exact value", async () => {
    const { file } = fixture();
    const firstRun = await run(file);
    const first = readFileSync(file, "utf8");
    expect(first).toMatch(/^cek1:[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(firstRun.stdout).not.toContain(first);

    const secondRun = await run(file);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(secondRun.stdout).not.toContain(first);
  });

  it("fsyncs the parent after publishing the target and after deleting the temporary file", () => {
    const { dir, file } = fixture();
    const stages: string[] = [];

    ensureConfigEncryptionKeyFile(file, {
      environment: fileEnvironment(),
      fsyncDirectoryFn(directory, stage) {
        stages.push(`${directory}:${stage}`);
        fsyncDirectory(directory);
      },
      log() {},
    });

    expect(stages).toEqual([`${dir}:after-link`, `${dir}:after-unlink`]);
    expect(readdirSync(dir)).toEqual(["config-encryption-key"]);
  });

  it("accepts a legacy key file verbatim", async () => {
    const { file } = fixture();
    const legacy = "legacy-config-key-material";
    writeFileSync(file, legacy, { mode: 0o644 });

    await run(file);

    expect(readFileSync(file, "utf8")).toBe(legacy);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("loads a regular file through the descriptor-bound path and fchmods it to 0600", () => {
    const { file } = fixture();
    writeFileSync(file, "descriptor-bound-config-key", { mode: 0o644 });

    ensureConfigEncryptionKeyFile(file, {
      environment: fileEnvironment(),
      log() {},
    });

    expect(readFileSync(file, "utf8")).toBe("descriptor-bound-config-key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("normalizes legacy file whitespace with origin/main trim semantics", async () => {
    const { file } = fixture();
    writeFileSync(file, "  legacy-key-value \n\n", { mode: 0o600 });

    ensureConfigEncryptionKeyFile(file, {
      environment: fileEnvironment(),
      log() {},
    });

    expect(readFileSync(file, "utf8")).toBe("  legacy-key-value \n\n");
  });

  it.each([
    ["cek1:abc\n\n", "cek1:abc"],
    [" cek1:abc", "cek1:abc"],
    ["  legacy \n\n", "legacy"],
    ["key\r\n\r\n", "key"],
  ])("loads %j using origin/main trim semantics", async (value, expected) => {
    const { file } = fixture();
    writeFileSync(file, value, { mode: 0o600 });
    const messages: string[] = [];

    ensureConfigEncryptionKeyFile(file, {
      environment: fileEnvironment(),
      log(message) {
        messages.push(message);
      },
    });

    expect(messages).toEqual(["Loaded persistent config encryption key"]);
    expect(readFileSync(file, "utf8").trim()).toBe(expected);
  });

  it("uses an environment override without creating or modifying a file", async () => {
    const { file } = fixture();
    const external = "external-config-key";
    const resultWithoutFile = await run(file, external);
    expect(() => readFileSync(file)).toThrow();
    expect(resultWithoutFile.stdout).not.toContain(external);

    const existing = "existing-config-key";
    writeFileSync(file, existing, { mode: 0o644 });
    chmodSync(file, 0o644);
    const before = statSync(file);
    const resultWithFile = await run(file, external);
    const after = statSync(file);
    expect(readFileSync(file, "utf8")).toBe(existing);
    expect(after.mode & 0o777).toBe(0o644);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(resultWithFile.stdout).not.toContain(external);
  });

  it("does not execute any file-publication fsync for an environment override", () => {
    const { file } = fixture();
    ensureConfigEncryptionKeyFile(file, {
      environment: { ...process.env, CONFIG_ENCRYPTION_KEY: "external-config-key" },
      fsyncDirectoryFn() {
        throw new Error("environment override must not mutate a directory");
      },
      log() {},
    });
    expect(() => readFileSync(file)).toThrow();
  });

  it.each(["", "                                "])(
    "rejects an existing empty or whitespace file: %s",
    async (value) => {
      const { file } = fixture();
      writeFileSync(file, value, { mode: 0o600 });
      await expect(run(file)).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(value);
    },
  );

  it("rejects an existing directory target", async () => {
    const { file } = fixture();
    mkdirSync(file);
    await expect(run(file)).rejects.toThrow();
    expect(statSync(file).isDirectory()).toBe(true);
  });

  it("rejects an existing FIFO target without blocking", async () => {
    const { file } = fixture();
    try {
      execFileSync("mkfifo", [file]);
    } catch (error) {
      // Some sandboxes disallow mknod/mkfifo even on Linux. Keep the real FIFO
      // regression active where permitted, and skip only when fixture creation is blocked.
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        console.warn("Skipping FIFO rejection regression: mkfifo is not permitted here");
        return;
      }
      throw error;
    }

    await expect(run(file)).rejects.toThrow("CONFIG_ENCRYPTION_KEY_FILE is missing or invalid");
  });

  it("rejects an existing symlink target", async () => {
    const { dir, file } = fixture();
    const linked = path.join(dir, "linked");
    writeFileSync(linked, "legacy-config-key", { mode: 0o600 });
    symlinkSync(linked, file);

    await expect(run(file)).rejects.toThrow("CONFIG_ENCRYPTION_KEY_FILE is missing or invalid");
    expect(readFileSync(linked, "utf8")).toBe("legacy-config-key");
  });

  it("fails loudly on parent-directory fsync failure but reuses the published target next time", async () => {
    const { dir, file } = fixture();
    const stages: string[] = [];

    expect(() =>
      ensureConfigEncryptionKeyFile(file, {
        environment: fileEnvironment(),
        fsyncDirectoryFn(directory, stage) {
          stages.push(stage);
          if (stage === "after-link") throw new Error("simulated directory fsync failure");
          fsyncDirectory(directory);
        },
        log() {},
      }),
    ).toThrow("unable to create persistent config encryption key");

    const published = readFileSync(file, "utf8");
    expect(published).toMatch(/^cek1:[A-Za-z0-9_-]{43}$/);
    expect(stages).toEqual(["after-link", "after-unlink"]);
    expect(readdirSync(dir)).toEqual(["config-encryption-key"]);

    await run(file);
    expect(readFileSync(file, "utf8")).toBe(published);
    expect(readdirSync(dir)).toEqual(["config-encryption-key"]);
  });

  it("fsyncs the parent in the concurrent loser path after reading the winner", () => {
    const { dir, file } = fixture();
    const stages: string[] = [];
    let linked = false;

    const result = ensureConfigEncryptionKeyFile(file, {
      environment: fileEnvironment(),
      linkSyncFn() {
        if (!linked) {
          linked = true;
          writeFileSync(file, "winner-config-key", { mode: 0o600 });
          const error = new Error("simulated concurrent winner") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }
        throw new Error("unexpected second link attempt");
      },
      fsyncDirectoryFn(directory, stage) {
        stages.push(`${directory}:${stage}`);
      },
      log() {},
    });

    expect(result).toBe("generated");
    expect(stages).toEqual([`${dir}:after-link`, `${dir}:after-unlink`]);
    expect(readFileSync(file, "utf8")).toBe("winner-config-key");
  });

  it("publishes one complete value under concurrent first startup", async () => {
    const { file } = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => run(file)));
    const value = readFileSync(file, "utf8");
    expect(value).toMatch(/^cek1:[A-Za-z0-9_-]{43}$/);
    expect(results.every((result) => !result.stdout.includes(value))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("generates key material with the versioned prefix", () => {
    const { file } = fixture();
    ensureConfigEncryptionKeyFile(file, {
      environment: fileEnvironment(),
      randomBytesFn(size) {
        return Buffer.alloc(size, 1);
      },
      fsyncDirectoryFn() {},
      log() {},
    });

    expect(readFileSync(file, "utf8").startsWith(CONFIG_ENCRYPTION_KEY_PREFIX)).toBe(true);
  });
});
