import { afterEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { getBuildInfo } from "@/lib/build-info";
import { getEnv } from "@/lib/env";
import { getIntegrationStatuses } from "@/modules/integration";

import { getSystemStatus } from "./status";

vi.mock("@/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/build-info", () => ({
  getBuildInfo: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(),
}));

vi.mock("@/modules/integration", () => ({
  getIntegrationStatuses: vi.fn(),
}));

describe("getSystemStatus", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("reports runtime build metadata from the image build-info source", async () => {
    vi.mocked(getEnv).mockReturnValue({ APP_URL: "https://example.test" } as ReturnType<
      typeof getEnv
    >);
    vi.mocked(getBuildInfo).mockReturnValue({
      appVersion: "1.2.3",
      sourceCommit: "abc123",
      buildTimestamp: "2026-07-05T00:00:00Z",
    });
    vi.mocked(getIntegrationStatuses).mockResolvedValue([]);
    vi.mocked(getDb).mockReturnValue({
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getDb>);

    await expect(getSystemStatus()).resolves.toMatchObject({
      appUrl: "https://example.test",
      version: "1.2.3",
      sourceCommit: "abc123",
      buildTimestamp: "2026-07-05T00:00:00Z",
      databaseOk: true,
      integrations: [],
    });
  });
});
