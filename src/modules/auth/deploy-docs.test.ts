import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("home server auth hardening docs", () => {
  it("describes production auth as fail-closed when trusted IP resolution fails", async () => {
    const doc = await readFile(path.join(process.cwd(), "docs/deploy-home-server.md"), "utf8");

    expect(doc).not.toContain("认证、下载与上传会退回各操作专用的 unresolved emergency 桶");
    expect(doc).not.toContain("当前认证路径仍是 S4 前行为");
    expect(doc).not.toContain("admin-login:unknown");
    expect(doc).toContain("request-code");
    expect(doc).toContain("verify-code");
    expect(doc).toMatch(/`admin-login`、`request-code`、`verify-code`、Magic Link 和 OAuth/);
    expect(doc).toContain("失败关闭");
    expect(doc).toContain("不再把不同访客压进共享认证桶");
  });
});
