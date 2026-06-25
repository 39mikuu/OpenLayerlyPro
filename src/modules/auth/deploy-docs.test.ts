import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("home server auth hardening docs", () => {
  it("keeps planned S4 auth unresolved buckets distinct from current auth behavior", async () => {
    const doc = await readFile(path.join(process.cwd(), "docs/deploy-home-server.md"), "utf8");

    expect(doc).not.toContain("认证、下载与上传会退回各操作专用的 unresolved emergency 桶");
    expect(doc).toContain("当前认证路径仍是 S4 前行为");
    expect(doc).toContain("admin-login:unknown");
    expect(doc).toContain("request-code");
    expect(doc).toContain("verify-code");
    expect(doc).toMatch(/S4 实现合并后，认证会改用各操作专用的 unresolved emergency 桶/);
  });
});
