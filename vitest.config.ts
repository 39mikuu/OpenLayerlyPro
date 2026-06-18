import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Database integration files truncate shared tables between cases.
    // Keep the regular unit suite parallel, but serialize files when those tests are enabled.
    fileParallelism: process.env.RUN_DB_INTEGRATION_TESTS !== "true",
  },
});
