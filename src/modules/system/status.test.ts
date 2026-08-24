import { afterEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { getBuildInfo } from "@/lib/build-info";
import { getEnv } from "@/lib/env";
import { getIntegrationStatuses } from "@/modules/integration";
import { getTaskQueueOperationalSnapshot } from "@/modules/tasks/operational-snapshot";

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

vi.mock("@/modules/tasks/operational-snapshot", () => ({
  getTaskQueueOperationalSnapshot: vi.fn(),
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
    vi.mocked(getTaskQueueOperationalSnapshot).mockResolvedValue({
      capturedAt: new Date("2026-07-05T00:00:00Z"),
      totals: {
        due: 1,
        scheduled: 2,
        activeLeases: 3,
        staleLeases: 4,
        exhausted: 5,
        stranded: 6,
        dead: 7,
        fenceAnomalies: 8,
        oldestDueAt: new Date("2026-07-04T23:00:00Z"),
      },
      queues: [],
    });
    vi.mocked(getDb).mockReturnValue({
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getDb>);

    await expect(getSystemStatus({ includeTaskQueue: true })).resolves.toMatchObject({
      appUrl: "https://example.test",
      version: "1.2.3",
      sourceCommit: "abc123",
      buildTimestamp: "2026-07-05T00:00:00Z",
      databaseOk: true,
      integrations: [],
      taskQueue: { totals: { due: 1, fenceAnomalies: 8 } },
    });
  });

  it("does not scan task history unless queue details are requested", async () => {
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

    await expect(getSystemStatus()).resolves.not.toHaveProperty("taskQueue");
    expect(getTaskQueueOperationalSnapshot).not.toHaveBeenCalled();
  });

  it("keeps system status available when the task queue snapshot fails", async () => {
    vi.mocked(getEnv).mockReturnValue({ APP_URL: "https://example.test" } as ReturnType<
      typeof getEnv
    >);
    vi.mocked(getBuildInfo).mockReturnValue({
      appVersion: "1.2.3",
      sourceCommit: "abc123",
      buildTimestamp: "2026-07-05T00:00:00Z",
    });
    vi.mocked(getIntegrationStatuses).mockResolvedValue([]);
    vi.mocked(getTaskQueueOperationalSnapshot).mockRejectedValue(new Error("snapshot failed"));
    vi.mocked(getDb).mockReturnValue({
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getDb>);

    await expect(getSystemStatus({ includeTaskQueue: true })).resolves.toMatchObject({
      databaseOk: true,
      taskQueue: null,
    });
  });
});
