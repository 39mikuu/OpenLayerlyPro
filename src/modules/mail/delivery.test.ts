import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import { classifyMailError, MailDeliveryError } from "./delivery";

describe("classifyMailError", () => {
  it.each([
    [{ responseCode: 550 }, "permanent"],
    [{ code: "EENVELOPE", responseCode: 553 }, "permanent"],
    [{ code: "ETIMEDOUT" }, "transient"],
    [{ code: "ECONNRESET" }, "transient"],
    [{ responseCode: 451 }, "transient"],
    [new Error("unknown provider failure"), "transient"],
    [new ApiError(500, "mailNotConfigured"), "needs_operator"],
    [{ code: "EAUTH", responseCode: 535 }, "needs_operator"],
  ] as const)("classifies %# as %s", (error, expected) => {
    expect(classifyMailError(error)).toBe(expected);
  });

  it("preserves an already-sanitized classification", () => {
    expect(classifyMailError(new MailDeliveryError("permanent"))).toBe("permanent");
  });
});
