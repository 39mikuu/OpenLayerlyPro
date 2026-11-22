import { defineConfig, devices } from "@playwright/test";

const trustedProxyIp = process.env.E2E_TRUSTED_PROXY_IP ?? "127.0.0.1";
const trustedProxyHops = process.env.E2E_TRUSTED_PROXY_HOPS ?? "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    extraHTTPHeaders: { "x-forwarded-for": trustedProxyIp },
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm start --port 3001",
    env: {
      ...process.env,
      AUTH_ALLOW_UNRESOLVED_CLIENT_IP: "false",
      TRUSTED_PROXY_HOPS: trustedProxyHops,
    },
    url: "http://127.0.0.1:3001/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
