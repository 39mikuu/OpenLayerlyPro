import { execFile } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";

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

  it("uses an environment override without creating or modifying a file", async () => {
    const { file } = fixture();
    const external = "external-session-secret-012345678901234";
    const result = await run(file, external);
    expect(() => readFileSync(file)).toThrow();
    expect(result.stdout).not.toContain(external);
  });

  it.each(["", "short", "change-me"])("rejects an existing weak file: %s", async (value) => {
    const { file } = fixture();
    writeFileSync(file, value, { mode: 0o600 });
    await expect(run(file)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(value);
  });

  it("publishes one complete value under concurrent first startup", async () => {
    const { file } = fixture();
    const results = await Promise.all([run(file), run(file)]);
    const value = readFileSync(file, "utf8");
    expect(value).toHaveLength(43);
    expect(results.every((result) => !result.stdout.includes(value))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("fails without replacing a non-regular existing target", async () => {
    const { file } = fixture();
    mkdirSync(file);
    await expect(run(file)).rejects.toThrow();
    expect(statSync(file).isDirectory()).toBe(true);
  });
});
