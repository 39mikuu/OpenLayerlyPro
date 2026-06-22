import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
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
  return execFileAsync(process.execPath, ["scripts/check-bounded-request-bodies.mjs", root], {
    cwd: process.cwd(),
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded Route Handler static check", () => {
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
});
