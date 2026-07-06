import { execFile } from "child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureSessionSecretFile,
  fsyncDirectory,
  readSessionSecretTarget,
} from "../../../docker/ensure-session-secret.mjs";

const execFileAsync = promisify(execFile);
const script = path.resolve("docker/ensure-session-secret.mjs");
const directories: string[] = [];

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "olp-entrypoint-secret-"));
  directories.push(dir);
  return { dir, file: path.join(dir, "session-secret") };
}

async function run(file: string, secret?: string) {
  return execFileAsync(process.execPath, [script, file], {
    env: { ...process.env, SESSION_SECRET: secret ?? "" },
  });
}

function fileEnvironment() {
  return { ...process.env, SESSION_SECRET: "" };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistent session secret creation", () => {
  it("generates once with mode 0600 and reuses the exact value without logging it", async () => {
    const { file } = fixture();
    const firstRun = await run(file);
    const first = readFileSync(file, "utf8");
    expect(first).toHaveLength(43);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(firstRun.stdout).not.toContain(first);

    const secondRun = await run(file);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(secondRun.stdout).not.toContain(first);
  });

  it("fsyncs the parent after publishing the target and after deleting the temporary file", () => {
    const { dir, file } = fixture();
    const stages: string[] = [];

    ensureSessionSecretFile(file, {
      environment: fileEnvironment(),
      fsyncDirectoryFn(directory, stage) {
        stages.push(`${directory}:${stage}`);
        fsyncDirectory(directory);
      },
      log() {},
    });

    expect(stages).toEqual([`${dir}:after-link`, `${dir}:after-unlink`]);
    expect(readdirSync(dir)).toEqual(["session-secret"]);
  });

  it("does not execute publication directory fsync when loading an existing file", () => {
    const { file } = fixture();
    const existing = "existing-session-secret-012345678901234";
    writeFileSync(file, existing, { mode: 0o600 });

    ensureSessionSecretFile(file, {
      environment: fileEnvironment(),
      fsyncDirectoryFn() {
        throw new Error("existing-file path must not publish directory entries");
      },
      log() {},
    });

    expect(readFileSync(file, "utf8")).toBe(existing);
  });

  it("uses an environment override without creating or modifying a file", async () => {
    const { file } = fixture();
    const external = "external-session-secret-012345678901234";
    const resultWithoutFile = await run(file, external);
    expect(() => readFileSync(file)).toThrow();
    expect(resultWithoutFile.stdout).not.toContain(external);

    const existing = "existing-session-secret-012345678901234";
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
    ensureSessionSecretFile(file, {
      environment: { ...process.env, SESSION_SECRET: "external-session-secret-012345678901234" },
      fsyncDirectoryFn() {
        throw new Error("environment override must not mutate a directory");
      },
      log() {},
    });
    expect(() => readFileSync(file)).toThrow();
  });

  it.each(["", "short", "change-me", "                                "])(
    "rejects an existing weak file: %s",
    async (value) => {
      const { file } = fixture();
      writeFileSync(file, value, { mode: 0o600 });
      await expect(run(file)).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(value);
    },
  );

  it("fails loudly on parent-directory fsync failure but reuses the published target next time", async () => {
    const { dir, file } = fixture();
    const stages: string[] = [];

    expect(() =>
      ensureSessionSecretFile(file, {
        environment: fileEnvironment(),
        fsyncDirectoryFn(directory, stage) {
          stages.push(stage);
          if (stage === "after-link") throw new Error("simulated directory fsync failure");
          fsyncDirectory(directory);
        },
        log() {},
      }),
    ).toThrow("unable to create persistent session secret");

    const published = readFileSync(file, "utf8");
    expect(published).toHaveLength(43);
    expect(stages).toEqual(["after-link", "after-unlink"]);
    expect(readdirSync(dir)).toEqual(["session-secret"]);

    await run(file);
    expect(readFileSync(file, "utf8")).toBe(published);
    expect(readdirSync(dir)).toEqual(["session-secret"]);
  });

  it("publishes one complete value under concurrent first startup", async () => {
    const { file } = fixture();
    const results = await Promise.all([run(file), run(file)]);
    const value = readFileSync(file, "utf8");
    expect(value).toHaveLength(43);
    expect(results.every((result) => !result.stdout.includes(value))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects a pre-existing symlink target via ELOOP mapping without replacing it", async () => {
    const { dir, file } = fixture();
    const attacker = path.join(dir, "attacker-secret");
    const attackerSecret = "attacker-controlled-session-secret-012345678901234";
    writeFileSync(attacker, attackerSecret, { mode: 0o644 });
    symlinkSync(attacker, file);

    // A pre-existing symlink exercises the O_NOFOLLOW ELOOP mapping; the race
    // regression below proves the descriptor, not the path, determines the read.
    await expect(run(file)).rejects.toThrow();

    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(attacker, "utf8")).toBe(attackerSecret);
    expect(statSync(attacker).mode & 0o777).toBe(0o644);
    expect(readFileSync(file, "utf8")).toBe(attackerSecret);
  });

  it("reads the validated descriptor when the target path is swapped after validation", () => {
    const { dir, file } = fixture();
    const original = "original-session-secret-012345678901234567";
    const attacker = path.join(dir, "attacker-secret");
    const attackerSecret = "attacker-controlled-session-secret-012345678901234";
    writeFileSync(file, original, { mode: 0o600 });

    const value = readSessionSecretTarget(file, {
      afterValidateHook() {
        unlinkSync(file);
        writeFileSync(attacker, attackerSecret, { mode: 0o644 });
        symlinkSync(attacker, file);
      },
    });

    expect(value).toBe(original);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(attackerSecret);
    expect(readFileSync(attacker, "utf8")).toBe(attackerSecret);
    expect(statSync(attacker).mode & 0o777).toBe(0o644);
  });

  it("fails without replacing a non-regular existing target", async () => {
    const { file } = fixture();
    mkdirSync(file);
    await expect(run(file)).rejects.toThrow();
    expect(statSync(file).isDirectory()).toBe(true);
  });
});
