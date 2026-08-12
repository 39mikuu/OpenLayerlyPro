import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loggerError: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  logger: { error: mocks.loggerError },
}));

import { compensateAndPreserveError } from "./compensation";

describe("compensateAndPreserveError", () => {
  beforeEach(() => {
    mocks.loggerError.mockReset();
  });

  it("runs every cleanup, records failures, and returns the original error object", async () => {
    const primary = Object.assign(new Error("database insert failed"), { code: "23503" });
    const firstCleanup = Object.assign(new Error("provider denied delete"), {
      code: "AccessDenied",
    });
    const secondCleanup = vi.fn();

    const preserved = await compensateAndPreserveError(
      primary,
      [
        { operation: "storage.delete_object", run: async () => Promise.reject(firstCleanup) },
        { operation: "reservation.rollback", run: secondCleanup },
      ],
      { objectKey: "payment-proof/object.png" },
    );

    expect(preserved).toBe(primary);
    expect(secondCleanup).toHaveBeenCalledOnce();
    expect(mocks.loggerError).toHaveBeenCalledWith("Compensation step failed", {
      objectKey: "payment-proof/object.png",
      operation: "storage.delete_object",
      primaryError: { name: "Error", identifier: "23503" },
      cleanupError: { name: "Error", identifier: "AccessDenied" },
    });
  });

  it("preserves the primary error when failure logging also throws", async () => {
    const primary = new Error("database insert failed");
    const secondCleanup = vi.fn();
    mocks.loggerError.mockImplementationOnce(() => {
      throw new Error("logger failed");
    });

    const preserved = await compensateAndPreserveError(primary, [
      {
        operation: "storage.delete_object",
        run: async () => {
          throw new Error("provider delete failed");
        },
      },
      { operation: "reservation.rollback", run: secondCleanup },
    ]);

    expect(preserved).toBe(primary);
    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(secondCleanup).toHaveBeenCalledOnce();
  });
});
