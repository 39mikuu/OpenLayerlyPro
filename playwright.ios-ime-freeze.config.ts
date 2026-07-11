import { defineConfig, devices } from "@playwright/test";

// Standalone config for the iOS Safari Chinese-IME investigation harness
// (e2e/ios-ime-freeze-measure.spec.ts). Kept separate from playwright.config.ts
// rather than added as a second `projects` entry there: combining a
// `testMatch`-restricted project with an unrestricted one in a single
// `projects` array was observed to make Playwright 1.61.1 misassign every
// test in the suite to the restricted project instead of splitting them
// (the unrestricted project matched zero tests). A dedicated config file
// avoids that interaction entirely.
//
// Run with: pnpm exec playwright test --config=playwright.ios-ime-freeze.config.ts
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/ios-ime-freeze*",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    ...devices["iPhone 13"],
    locale: "zh-CN",
  },
  webServer: {
    command: "pnpm start --port 3001",
    url: "http://127.0.0.1:3001/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
