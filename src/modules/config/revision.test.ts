import { describe, expect, it } from "vitest";

import { requireExpectedRevision, requireWrittenRevision } from "./revision";

describe("config write response revision", () => {
  it("rejects stale input before masked fields are merged or validated", () => {
    expect(() => requireExpectedRevision(5, 4)).toThrowError(
      expect.objectContaining({ status: 409, code: "configConflict" }),
    );
    expect(() => requireExpectedRevision(4, 4)).not.toThrow();
  });

  it("returns only a view that matches the revision written by this request", () => {
    expect(requireWrittenRevision({ revision: 4, value: "current" }, 4)).toEqual({
      revision: 4,
      value: "current",
    });
  });

  it("forces a refresh if another write wins before the response view is read", () => {
    expect(() => requireWrittenRevision({ revision: 5 }, 4)).toThrowError(
      expect.objectContaining({ status: 409, code: "configConflict" }),
    );
  });
});
