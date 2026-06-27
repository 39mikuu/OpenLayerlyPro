import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

type ComposeConfig = {
  services?: Record<string, { ports?: unknown[] | null }>;
};

function hasDockerCompose(): boolean {
  return spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
}

const composeIsRequired = process.env.CI === "true";
const describeWithCompose = composeIsRequired || hasDockerCompose() ? describe : describe.skip;

describeWithCompose("production Compose overlays", () => {
  it.each(["docker-compose.caddy.yml", "docker-compose.tunnel.yml"])(
    "%s clears the inherited app host ports",
    (overlay) => {
      const repoRoot = resolve(process.cwd());
      const workDir = mkdtempSync(join(tmpdir(), "openlayerly-compose-"));

      try {
        copyFileSync(join(repoRoot, "docker-compose.yml"), join(workDir, "docker-compose.yml"));
        copyFileSync(join(repoRoot, overlay), join(workDir, overlay));
        writeFileSync(join(workDir, ".env"), "SESSION_SECRET=compose-config-test-secret\n");

        const rendered = execFileSync(
          "docker",
          [
            "compose",
            "-f",
            "docker-compose.yml",
            "-f",
            overlay,
            "config",
            "--format",
            "json",
          ],
          {
            cwd: workDir,
            encoding: "utf8",
            env: {
              ...process.env,
              APP_DOMAIN: "artist.example.test",
              CLOUDFLARE_TUNNEL_TOKEN: "compose-config-test-token",
            },
          },
        );

        const config = JSON.parse(rendered) as ComposeConfig;
        expect(config.services?.app?.ports ?? []).toEqual([]);
      } finally {
        rmSync(workDir, { force: true, recursive: true });
      }
    },
  );
});
