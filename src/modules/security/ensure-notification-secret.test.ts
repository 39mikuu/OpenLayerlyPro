import { execFile, execFileSync } from "child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
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

import { ensureNotificationSecretFile } from "../../../docker/ensure-notification-secret.mjs";

const execFileAsync = promisify(execFile);
const script = path.resolve("docker/ensure-notification-secret.mjs");
const directories: string[] = [];

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "olp-notification-secret-"));
  directories.push(dir);
  return { dir, file: path.join(dir, "notification-secret") };
}

async function run(file: string, secret?: string) {
  return execFileAsync(
    process.execPath,
    [script, file, "NOTIFICATION_TEST_SECRET", "notification test secret"],
    {
      env: { ...process.env, NOTIFICATION_TEST_SECRET: secret ?? "" },
    },
  );
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistent notification secret creation", () => {
  it("generates and reuses a trimmed persistent secret with mode 0600", async () => {
    const { file } = fixture();

    const firstRun = await run(file);
    const first = readFileSync(file, "utf8");
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(firstRun.stdout).not.toContain(first);

    const secondRun = await run(file);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(secondRun.stdout).not.toContain(first);
  });

  it("uses a valid environment override without touching the file", async () => {
    const { file } = fixture();
    const external = "external-notification-secret-0123456789";

    await expect(run(file, external)).resolves.toMatchObject({
      stdout: expect.not.stringContaining(external),
    });
    expect(() => readFileSync(file)).toThrow();
  });

  it.each([
    "short",
    "x                               ",
    "change-me",
    "                                ",
  ])("rejects weak environment override: %s", async (value) => {
    const { file } = fixture();
    await expect(run(file, value)).rejects.toThrow();
    expect(() => readFileSync(file)).toThrow();
  });

  it.each([
    "short",
    "x                               ",
    "change-me",
    "                                ",
  ])("rejects weak existing files without replacing them: %s", async (value) => {
    const { file } = fixture();
    writeFileSync(file, value, { mode: 0o600 });

    await expect(run(file)).rejects.toThrow();

    expect(readFileSync(file, "utf8")).toBe(value);
  });

  it("rejects a symlink target without replacing it", async () => {
    const { dir, file } = fixture();
    const attacker = path.join(dir, "attacker-secret");
    const attackerSecret = "attacker-controlled-notification-secret-0123456789";
    writeFileSync(attacker, attackerSecret, { mode: 0o644 });
    symlinkSync(attacker, file);

    await expect(run(file)).rejects.toThrow();

    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(attacker, "utf8")).toBe(attackerSecret);
  });

  it("rejects a FIFO target instead of blocking on open", async () => {
    const { file } = fixture();
    try {
      execFileSync("mkfifo", [file]);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        return;
      }
      throw error;
    }

    const child = execFile(
      process.execPath,
      [script, file, "NOTIFICATION_TEST_SECRET", "notification test secret"],
      {
        env: { ...process.env, NOTIFICATION_TEST_SECRET: "" },
      },
    );

    const outcome = await Promise.race([
      new Promise<"exited">((resolve) => child.on("exit", () => resolve("exited"))),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]);

    if (outcome === "timeout") child.kill("SIGKILL");

    expect(outcome).toBe("exited");
    expect(child.exitCode).not.toBe(0);
  });

  it("does not fsync file publication when an environment override is present", () => {
    const { file } = fixture();

    expect(
      ensureNotificationSecretFile(file, {
        envName: "NOTIFICATION_TEST_SECRET",
        label: "notification test secret",
        environment: {
          ...process.env,
          NOTIFICATION_TEST_SECRET: "external-notification-secret-0123456789",
        },
        fsyncDirectoryFn() {
          throw new Error("environment override must not publish files");
        },
        log() {},
      }),
    ).toBe("external");
  });

  it("fails without replacing a non-regular existing target", async () => {
    const { file } = fixture();
    mkdirSync(file);
    await expect(run(file)).rejects.toThrow();
    expect(statSync(file).isDirectory()).toBe(true);
  });
});
