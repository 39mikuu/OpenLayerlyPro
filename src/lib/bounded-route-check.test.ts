import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bounded-route-check-"));
  tempRoots.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

async function runCheck(root: string) {
  const stdoutPath = path.join(root, `.bounded-route-check-${process.pid}-${Date.now()}.stdout`);
  const stderrPath = path.join(root, `.bounded-route-check-${process.pid}-${Date.now()}.stderr`);
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/check-bounded-request-bodies.mjs", root], {
        cwd: process.cwd(),
        stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
      });
      child.on("error", reject);
      child.on("close", async (code) => {
        await stdoutFile.close();
        await stderrFile.close();
        resolve({
          code,
          stdout: await readFile(stdoutPath, "utf8"),
          stderr: await readFile(stderrPath, "utf8"),
        });
      });
    },
  );

  if (result.code === 0) return { stdout: result.stdout, stderr: result.stderr };

  const error = new Error(`check-bounded-request-bodies exited with ${result.code}`) as Error & {
    code: number | null;
    stdout: string;
    stderr: string;
  };
  error.code = result.code;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  throw error;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded Route Handler static check", () => {
  it.each([
    ["renamed parameter", "export async function POST(r: Request) { await r.json(); }", "json"],
    [
      "alias",
      "export async function POST(input: Request) { const alias = input; await alias.text(); }",
      "text",
    ],
    [
      "element access",
      'export const PUT = async (incoming: Request) => incoming["json"]();',
      "json",
    ],
    [
      "parentheses and type assertion",
      "export async function PATCH(input: Request) { await ((input as Request)).formData(); }",
      "formData",
    ],
    [
      "optional chain",
      "export async function DELETE(incoming: Request) { await incoming?.text(); }",
      "text",
    ],
    [
      "assigned alias",
      "export async function POST(input: Request) { let alias: Request; alias = input; await alias.json(); }",
      "json",
    ],
    [
      "arrayBuffer",
      "export async function POST(req: Request) { await req.arrayBuffer(); }",
      "arrayBuffer",
    ],
    [
      "arrayBuffer element access",
      'export async function POST(req: Request) { await req["arrayBuffer"](); }',
      "arrayBuffer",
    ],
    [
      "arrayBuffer through aliased request",
      "export async function POST(req: Request) { const aliased = req; await aliased.arrayBuffer(); }",
      "arrayBuffer",
    ],
    ["blob", "export async function POST(req: Request) { await req.blob(); }", "blob"],
  ])("rejects %s", async (_name, source, method) => {
    const root = await createFixture({
      "unsafe/route.ts": source,
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining(`.${method}()`),
    });
  });

  it("fails with file and line information for direct req.json()", async () => {
    const root = await createFixture({
      "unsafe/route.ts": [
        "export async function POST(req: Request) {",
        "  return Response.json(await req.json());",
        "}",
      ].join("\n"),
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("unsafe/route.ts:2:"),
    });
  });

  it("allows bounded helper calls", async () => {
    const root = await createFixture({
      "safe/route.ts": [
        'import { readJsonWithLimit } from "@/lib/request-body";',
        "export async function POST(req: Request) {",
        "  return Response.json(await readJsonWithLimit(req, 1024, schema));",
        "}",
        "export function GET() {",
        "  return Response.json({ ok: true });",
        "}",
      ].join("\n"),
    });

    await expect(runCheck(root)).resolves.toMatchObject({
      stdout: expect.stringContaining("Bounded request-body check passed"),
    });
  });

  it("does not scan test files or fixtures that are not production route files", async () => {
    const root = await createFixture({
      "ignored/route.test.ts": "export const fixture = (req: Request) => req.formData();",
      "ignored/fixture.ts": "export const fixture = (request: Request) => request.text();",
      "safe/route.ts": "export async function GET() { return new Response('ok'); }",
    });

    await expect(runCheck(root)).resolves.toMatchObject({
      stdout: expect.stringContaining("Bounded request-body check passed"),
    });
  });

  it("scans non-api Route Handlers under the full app tree", async () => {
    const root = await createFixture({
      "download/[fileId]/route.ts":
        "export async function POST(payload: Request) { return payload.formData(); }",
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining(".formData()"),
    });
  });
});
