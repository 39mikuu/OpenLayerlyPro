import { describe, expect, it, vi } from "vitest";

import { compensateAndPreserveError } from "./compensation";

describe("compensation logging", () => {
  it("serializes safe identifiers without raw error messages", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const primary = Object.assign(new Error("database contains private detail"), { code: "23503" });

    const preserved = await compensateAndPreserveError(
      primary,
      [
        {
          operation: "storage.delete_object",
          run: async () => {
            throw Object.assign(new Error("provider leaked a private name"), {
              code: "AccessDenied",
            });
          },
        },
      ],
      { objectRef: "a".repeat(64) },
    );

    expect(preserved).toBe(primary);
    expect(output).toHaveBeenCalledOnce();
    const line = String(output.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      operation: "storage.delete_object",
      objectRef: "a".repeat(64),
      primaryError: { name: "Error", identifier: "23503" },
      cleanupError: { name: "Error", identifier: "AccessDenied" },
    });
    expect(line).not.toContain("database contains private detail");
    expect(line).not.toContain("provider leaked a private name");
    output.mockRestore();
  });

  it("classifies a wrapped error by its safe cause identifier", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = Object.assign(new Error("database contains private detail"), { code: "22012" });
    const primary = new Error("query wrapper contains private SQL", { cause });
    primary.name = "DrizzleQueryError";

    await compensateAndPreserveError(
      primary,
      [
        {
          operation: "storage.delete_object",
          run: async () => {
            throw new Error("cleanup contains private detail");
          },
        },
      ],
      { objectRef: "b".repeat(64) },
    );

    const line = String(output.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      primaryError: { name: "DrizzleQueryError", identifier: "22012" },
    });
    expect(line).not.toContain("database contains private detail");
    expect(line).not.toContain("query wrapper contains private SQL");
    output.mockRestore();
  });
});
