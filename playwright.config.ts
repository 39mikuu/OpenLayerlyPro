import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The iOS Safari Chinese-IME investigation harness runs under its own
  // config (playwright.ios-ime-freeze.config.ts) with a WebKit/iPhone
  // device profile; keep it out of the default Desktop Chrome suite.
  testIgnore: "**/ios-ime-freeze*",
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
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm start --port 3001",
    url: "http://127.0.0.1:3001/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
