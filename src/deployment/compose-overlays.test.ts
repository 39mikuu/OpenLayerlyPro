import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type ComposeConfig = {
  services?: {
    app?: {
      ports?: unknown[] | null;
    };
  };
};

function hasDockerCompose(): boolean {
  const result = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

const shouldRunComposeTests = process.env.CI === "true" || hasDockerCompose();

describe.runIf(shouldRunComposeTests)("production Compose overlays", () => {
  it.each(["docker-compose.caddy.yml", "docker-compose.tunnel.yml"])(
    "%s clears the inherited app host ports",
    (overlay) => {
      const repoRoot = process.cwd();
      const workDir = mkdtempSync(join(tmpdir(), "openlayerly-compose-"));

      try {
        for (const file of ["docker-compose.yml", overlay]) {
          copyFileSync(join(repoRoot, file), join(workDir, file));
        }

        const envFile = "SESSION_SECRET=compose-config-test-secret\n";
        writeFileSync(join(workDir, ".env"), envFile);

        const args = [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          overlay,
          "config",
          "--format",
          "json",
        ];
        const rendered = execFileSync("docker", args, {
          cwd: workDir,
          encoding: "utf8",
          env: {
            ...process.env,
            APP_DOMAIN: "artist.example.test",
            CLOUDFLARE_TUNNEL_TOKEN: "compose-config-test-token",
          },
        });

        const config = JSON.parse(rendered) as ComposeConfig;
        expect(config.services?.app?.ports ?? []).toEqual([]);
      } finally {
        rmSync(workDir, { force: true, recursive: true });
      }
    },
  );
});
