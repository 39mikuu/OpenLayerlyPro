import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("auth client identity deployment contract", () => {
  it("documents fail-closed public ingress and the trusted-LAN direct exception", async () => {
    const [doc, envExample, baseCompose, caddyCompose, tunnelCompose, playwrightConfig] =
      await Promise.all([
        readFile(path.join(process.cwd(), "docs/deploy-home-server.md"), "utf8"),
        readFile(path.join(process.cwd(), ".env.example"), "utf8"),
        readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8"),
        readFile(path.join(process.cwd(), "docker-compose.caddy.yml"), "utf8"),
        readFile(path.join(process.cwd(), "docker-compose.tunnel.yml"), "utf8"),
        readFile(path.join(process.cwd(), "playwright.config.ts"), "utf8"),
      ]);

    expect(doc).not.toContain("认证、下载与上传会退回各操作专用的 unresolved emergency 桶");
    expect(doc).not.toContain("当前认证路径仍是 S4 前行为");
    expect(doc).not.toContain("admin-login:unknown");
    expect(doc).toContain("request-code");
    expect(doc).toContain("verify-code");
    expect(doc).toMatch(/`admin-login`、`request-code`、`verify-code`、Magic Link 和 OAuth/);
    expect(doc).toContain("失败关闭");
    expect(doc).toContain("不再把不同访客压进共享认证桶");
    expect(doc).toContain("受信任局域网/防火墙");
    expect(doc).toContain("不得把这个模式暴露到公网");
    expect(envExample).toContain("AUTH_ALLOW_UNRESOLVED_CLIENT_IP=false");
    expect(baseCompose).toContain(
      "AUTH_ALLOW_UNRESOLVED_CLIENT_IP: ${DIRECT_COMPOSE_AUTH_ALLOW_UNRESOLVED_CLIENT_IP:-true}",
    );
    expect(envExample).toContain("DIRECT_COMPOSE_AUTH_ALLOW_UNRESOLVED_CLIENT_IP=");
    expect(caddyCompose).toContain('AUTH_ALLOW_UNRESOLVED_CLIENT_IP: "false"');
    expect(tunnelCompose).toContain('AUTH_ALLOW_UNRESOLVED_CLIENT_IP: "false"');
    expect(playwrightConfig).toContain('process.env.E2E_TRUSTED_PROXY_IP ?? "127.0.0.1"');
    expect(playwrightConfig).toContain('process.env.E2E_TRUSTED_PROXY_HOPS ?? "1"');
    expect(playwrightConfig).toContain('AUTH_ALLOW_UNRESOLVED_CLIENT_IP: "false"');
  });
});
