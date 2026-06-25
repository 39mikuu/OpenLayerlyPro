import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  end: vi.fn(),
  postgres: vi.fn(),
  drizzle: vi.fn(),
}));

vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ DATABASE_URL: "postgresql://example" }) }));

describe("database pool lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as typeof globalThis & { __db?: unknown }).__db;
    mocks.end.mockResolvedValue(undefined);
    mocks.postgres.mockImplementation(() => ({ end: mocks.end }));
    mocks.drizzle.mockImplementation((client) => ({ $client: client }));
  });

  it("closes the shared client and permits clean reinitialization", async () => {
    const { closeDb, getDb } = await import("./index");
    const first = getDb();
    expect(getDb()).toBe(first);

    await closeDb();

    expect(mocks.end).toHaveBeenCalledWith({ timeout: 5 });
    const second = getDb();
    expect(second).not.toBe(first);
    expect(mocks.postgres).toHaveBeenCalledTimes(2);
  });

  it("is a no-op before initialization", async () => {
    const { closeDb } = await import("./index");
    await closeDb();
    expect(mocks.end).not.toHaveBeenCalled();
  });
});
