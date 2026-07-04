import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "auth-before-body-check-"));
  tempRoots.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

async function runCheck(root: string, args: string[] = []) {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "auth-before-body-output-"));
  tempRoots.push(outputRoot);
  const stdoutPath = path.join(outputRoot, `.auth-before-body-${process.pid}-${Date.now()}.stdout`);
  const stderrPath = path.join(outputRoot, `.auth-before-body-${process.pid}-${Date.now()}.stderr`);
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/check-auth-before-body.mjs", ...args, root], {
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

  const error = new Error(`check-auth-before-body exited with ${result.code}`) as Error & {
    code: number | null;
    stdout: string;
    stderr: string;
  };
  error.code = result.code;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  throw error;
}

function imports(extra = "") {
  return [
    'import { readJsonWithLimit } from "@/lib/request-body";',
    'import { requireAdmin } from "@/modules/auth/session";',
    extra,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseAuditSummary(stdout: string): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([^:]+): (\d+)$/.exec(line.trim());
    if (match) summary[match[1]!] = Number(match[2]);
  }
  return summary;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("auth-before-body static check", () => {
  it("keeps the real route tree audit in a fully classified compliant state", async () => {
    const { stdout, stderr } = await runCheck(path.join(process.cwd(), "src/app"), ["--audit"]);
    const summary = parseAuditSummary(stdout);

    expect(stderr).toBe("");
    expect(summary.violations).toBe(0);
    expect(summary["needs-manual-review"]).toBe(0);
    expect(summary["unclassified write handlers"]).toBe(0);
    expect(summary["already compliant protected handlers"]).toBe(
      summary["protected body-reading handlers"]! + summary["protected bodyless handlers"]!,
    );
  });

  it("passes when top-level await requireAdmin() precedes a body read", async () => {
    const root = await createFixture({
      "safe/route.ts": `${imports()}
        export async function POST(req: Request) {
          await requireAdmin();
          const body = await readJsonWithLimit(req, 1024, schema);
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).resolves.toMatchObject({ stderr: "" });
  });

  it("flags a body read before auth as a violation", async () => {
    const root = await createFixture({
      "unsafe/route.ts": `${imports()}
        export async function POST(req: Request) {
          const body = await readJsonWithLimit(req, 1024, schema);
          await requireAdmin();
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("violation"),
    });
  });

  it("classifies auth inside an if block as needs-manual-review", async () => {
    const root = await createFixture({
      "conditional/route.ts": `${imports()}
        export async function POST(req: Request) {
          if (enabled) await requireAdmin();
          const body = await readJsonWithLimit(req, 1024, schema);
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("needs-manual-review"),
    });
  });

  it("passes with auth, then an unrelated early return, then a body read", async () => {
    const root = await createFixture({
      "safe/route.ts": `${imports()}
        export async function POST(req: Request) {
          await requireAdmin();
          if (maintenance) return Response.json({ ok: false });
          const body = await readJsonWithLimit(req, 1024, schema);
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).resolves.toMatchObject({ stderr: "" });
  });

  it("treats void requireAdmin() as not authenticated, producing a violation", async () => {
    const root = await createFixture({
      "void-auth/route.ts": `${imports()}
        export async function POST(req: Request) {
          void requireAdmin();
          const body = await readJsonWithLimit(req, 1024, schema);
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("violation"),
    });
  });

  it("flags delayed auth await as a violation", async () => {
    const root = await createFixture({
      "delayed/route.ts": `${imports()}
        export async function POST(req: Request) {
          const p = requireAdmin();
          const body = await readJsonWithLimit(req, 1024, schema);
          await p;
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("violation"),
    });
  });

  it("classifies request passed to a non-safe-list function before auth as needs-manual-review", async () => {
    const root = await createFixture({
      "escape/route.ts": `${imports()}
        export async function POST(req: Request) {
          inspectRequest(req);
          await requireAdmin();
          return Response.json({ ok: true });
        }`,
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("needs-manual-review"),
    });
  });

  it("does not accept a locally declared fake requireAdmin", async () => {
    const root = await createFixture({
      "fake/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        async function requireAdmin() {}
        export async function POST(req: Request) {
          await requireAdmin();
          const body = await readJsonWithLimit(req, 1024, schema);
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("violation"),
    });
  });

  it("recognizes aliased auth imports", async () => {
    const root = await createFixture({
      "aliased/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        import { requireAdmin as adminCheck } from "@/modules/auth/session";
        export async function POST(req: Request) {
          await adminCheck();
          const body = await readJsonWithLimit(req, 1024, schema);
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).resolves.toMatchObject({ stderr: "" });
  });

  it("recognizes namespace auth imports", async () => {
    const root = await createFixture({
      "namespace/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        import * as session from "@/modules/auth/session";
        export async function POST(req: Request) {
          await session.requireAdmin();
          const body = await readJsonWithLimit(req, 1024, schema);
          return Response.json(body);
        }`,
    });

    await expect(runCheck(root)).resolves.toMatchObject({ stderr: "" });
  });

  it("classifies unresolvable wrapped handlers as needs-manual-review", async () => {
    const root = await createFixture({
      "wrapped/route.ts": `${imports()}
        export const POST = withWrapper(config, async (req: Request) => {
          await requireAdmin();
          return Response.json({ ok: true });
        });`,
    });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("needs-manual-review"),
    });
  });

  it("passes and prints the allowlisted line for an allowlist hit", async () => {
    const root = await createFixture({
      "src/app/api/auth/admin/login/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        export async function POST(req: Request) {
          const body = await readJsonWithLimit(req, 1024, schema);
          return Response.json(body);
        }`,
      "src/app/api/auth/request-code/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        export async function POST(req: Request) { return Response.json(await readJsonWithLimit(req, 1024, schema)); }`,
      "src/app/api/auth/verify-code/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        export async function POST(req: Request) { return Response.json(await readJsonWithLimit(req, 1024, schema)); }`,
      "src/app/api/admin/setup/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        export async function POST(req: Request) { return Response.json(await readJsonWithLimit(req, 1024, schema)); }`,
      "src/app/api/payments/webhook/stripe/route.ts": `
        import { readBoundedRawBody } from "@/lib/request-body";
        export async function POST(req: Request) { return Response.json(await readBoundedRawBody(req, 1024)); }`,
      "src/app/api/auth/logout/route.ts": `
        export async function POST() { return Response.json({ loggedOut: true }); }`,
    });

    await expect(runCheck(path.join(root, "src/app"))).resolves.toMatchObject({
      stdout: expect.stringContaining("allowlisted: POST src/app/api/auth/admin/login/route.ts"),
    });
  });

  it("fails when an allowlist entry points to a nonexistent file or method", async () => {
    const root = await createFixture({
      "src/app/safe/route.ts": `${imports()}
        export async function POST(req: Request) {
          await requireAdmin();
          return Response.json({ ok: true });
        }`,
    });

    await expect(runCheck(path.join(root, "src/app"))).rejects.toMatchObject({
      stderr: expect.stringContaining("allowlist entry does not match"),
    });
  });

  it("fails when an allowlisted handler no longer reads the body", async () => {
    const root = await createFixture({
      "src/app/api/auth/admin/login/route.ts": `
        export async function POST() {
          return Response.json({ ok: true });
        }`,
      "src/app/api/auth/request-code/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        export async function POST(req: Request) { return Response.json(await readJsonWithLimit(req, 1024, schema)); }`,
      "src/app/api/auth/verify-code/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        export async function POST(req: Request) { return Response.json(await readJsonWithLimit(req, 1024, schema)); }`,
      "src/app/api/admin/setup/route.ts": `
        import { readJsonWithLimit } from "@/lib/request-body";
        export async function POST(req: Request) { return Response.json(await readJsonWithLimit(req, 1024, schema)); }`,
      "src/app/api/payments/webhook/stripe/route.ts": `
        import { readBoundedRawBody } from "@/lib/request-body";
        export async function POST(req: Request) { return Response.json(await readBoundedRawBody(req, 1024)); }`,
      "src/app/api/auth/logout/route.ts": `
        export async function POST() { return Response.json({ loggedOut: true }); }`,
    });

    await expect(runCheck(path.join(root, "src/app"))).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "stale allowlist entry no longer has an A-category body read",
      ),
    });
  });

  it("passes a bodyless protected handler", async () => {
    const root = await createFixture({
      "bodyless/route.ts": `${imports()}
        export async function DELETE(_req: Request) {
          await requireAdmin();
          await deleteRecord();
          return Response.json({ ok: true });
        }`,
    });

    await expect(runCheck(root)).resolves.toMatchObject({ stderr: "" });
  });

  it.each([
    [
      "plain admin JSON route",
      "src/app/api/admin/categories/route.ts",
      (source: string) =>
        source
          .replace(
            "    await requireAdmin();\n    const input = await readJsonWithLimit(",
            "    const input = await readJsonWithLimit(",
          )
          .replace(
            "    return jsonOk(await createCategory(input));",
            "    await requireAdmin();\n    return jsonOk(await createCategory(input));",
          ),
    ],
    [
      "requireAdminSession JSON route",
      "src/app/api/admin/account/password/route.ts",
      (source: string) =>
        source
          .replace(
            "    const { user, tokenHash } = await requireAdminSession();\n    const input = await readJsonWithLimit(",
            "    const input = await readJsonWithLimit(",
          )
          .replace(
            "    return jsonOk(\n      await changeAdminPassword(user.id, {",
            "    const { user, tokenHash } = await requireAdminSession();\n    return jsonOk(\n      await changeAdminPassword(user.id, {",
          ),
    ],
    [
      "multipart admin upload route",
      "src/app/api/admin/files/upload/route.ts",
      (source: string) =>
        source.replace(
          "    const admin = await requireAdmin();\n    // Bounded read intentionally runs after auth so unauthenticated requests cannot trigger large buffering;\n    // absent or understated Content-Length paths are covered by the lightweight pre-auth IP bucket above.\n    const rawBody = await readBoundedRawBody(req, transferLimit);",
          "    // Bounded read intentionally runs after auth so unauthenticated requests cannot trigger large buffering;\n    // absent or understated Content-Length paths are covered by the lightweight pre-auth IP bucket above.\n    const rawBody = await readBoundedRawBody(req, transferLimit);\n    const admin = await requireAdmin();",
        ),
    ],
    [
      "pre-auth rate-limited payment proof upload route",
      "src/app/api/files/upload-payment-proof/route.ts",
      (source: string) =>
        source
          .replace(
            "    const user = await requireUser();\n    if (!rateLimit(`proof-upload:${user.id}`, 10, 60 * 60 * 1000)) {",
            "    if (!rateLimit(`proof-upload:${user.id}`, 10, 60 * 60 * 1000)) {",
          )
          .replace(
            "    // Bounded read intentionally runs after auth so unauthenticated requests cannot trigger large buffering;\n    // absent or understated Content-Length paths are covered by the lightweight pre-auth IP bucket above.\n    const rawBody = await readBoundedRawBody(req, transferLimit);",
            "    // Bounded read intentionally runs after auth so unauthenticated requests cannot trigger large buffering;\n    // absent or understated Content-Length paths are covered by the lightweight pre-auth IP bucket above.\n    const rawBody = await readBoundedRawBody(req, transferLimit);\n    const user = await requireUser();",
          ),
    ],
  ])("catches a mutated auth-after-body regression in %s", async (_name, relativePath, mutate) => {
    const source = await readFile(path.join(process.cwd(), relativePath), "utf8");
    const mutated = mutate(source);
    expect(mutated).not.toBe(source);

    const root = await createFixture({ [relativePath]: mutated });

    await expect(runCheck(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("violation"),
    });
  });
});
