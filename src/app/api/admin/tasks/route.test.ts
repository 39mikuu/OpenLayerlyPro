import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listTasks: vi.fn(),
  retryTask: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/tasks", () => ({
  listTasks: mocks.listTasks,
  retryTask: mocks.retryTask,
}));

import { POST } from "./[id]/retry/route";
import { GET } from "./route";

function request(status?: string): NextRequest {
  return new NextRequest(`http://localhost/api/admin/tasks${status ? `?status=${status}` : ""}`);
}

function context() {
  return { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };
}

describe("admin tasks API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.listTasks.mockResolvedValue([]);
    mocks.retryTask.mockResolvedValue({ id: "task", status: "pending" });
  });

  it.each([
    [401, "authRequired"],
    [403, "adminRequired"],
  ])("requires admin access (%s)", async (status, code) => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(status, code));

    const [listResponse, retryResponse] = await Promise.all([
      GET(request()),
      POST(request(), context()),
    ]);

    expect(listResponse.status).toBe(status);
    expect(retryResponse.status).toBe(status);
    expect(mocks.listTasks).not.toHaveBeenCalled();
    expect(mocks.retryTask).not.toHaveBeenCalled();
  });

  it("filters by a supported status and ignores unknown filters", async () => {
    await GET(request("dead"));
    await GET(request("unknown"));

    expect(mocks.listTasks).toHaveBeenNthCalledWith(1, { status: "dead" });
    expect(mocks.listTasks).toHaveBeenNthCalledWith(2, { status: undefined });
  });

  it("returns only the safe task view produced by the task module", async () => {
    mocks.listTasks.mockResolvedValue([
      {
        id: "task-1",
        kind: "email",
        status: "dead",
        attempts: 5,
        maxAttempts: 5,
        runAfter: new Date("2026-06-18T10:00:00.000Z"),
        lastError: "SMTP unavailable",
        createdAt: new Date("2026-06-18T09:00:00.000Z"),
      },
    ]);

    const response = await GET(request());
    const body = await response.json();

    expect(body.data[0]).not.toHaveProperty("payloadJson");
    expect(body.data[0]).not.toHaveProperty("dedupeKey");
  });

  it("retries a failed or dead task through the task service", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.retryTask).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("preserves the stable not-retryable error", async () => {
    mocks.retryTask.mockRejectedValue(new ApiError(409, "taskNotRetryable"));

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "taskNotRetryable",
    });
  });
});
