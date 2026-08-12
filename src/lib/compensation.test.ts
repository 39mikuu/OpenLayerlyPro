import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loggerError: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  logger: { error: mocks.loggerError },
}));

import { compensateAndPreserveError } from "./compensation";

describe("compensateAndPreserveError", () => {
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
});
