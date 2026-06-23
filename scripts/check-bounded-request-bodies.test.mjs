import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkRouteTree, findDirectBodyReads } from "./check-bounded-request-bodies.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded request-body static gate", () => {
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
  ])("rejects %s", (_name, source, method) => {
    expect(findDirectBodyReads(source)).toEqual([
      expect.objectContaining({ requestName: expect.any(String), method }),
    ]);
  });

  it("allows bounded helpers and unrelated response serialization", () => {
    const source = `
      export async function POST(input: Request) {
        return readJsonWithLimit(input, 1024, schema);
      }
      export function GET() {
        return NextResponse.json({ ok: true });
      }
    `;

    expect(findDirectBodyReads(source)).toEqual([]);
  });

  it("scans non-api Route Handlers under the full app tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bounded-route-tree-"));
    temporaryRoots.push(root);
    const routeDirectory = path.join(root, "download", "[fileId]");
    await mkdir(routeDirectory, { recursive: true });
    await writeFile(
      path.join(routeDirectory, "route.ts"),
      "export async function POST(payload: Request) { return payload.formData(); }",
      "utf8",
    );

    const violations = await checkRouteTree(root);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual(expect.objectContaining({ method: "formData" }));
  });
});
