import { describe, expect, it } from "vitest";

import { pickMembershipAudit } from "./index";

describe("membership audit snapshots", () => {
  it("keeps only the approved membership fields", () => {
    const snapshot = pickMembershipAudit({
      status: "active",
      startsAt: new Date("2026-06-18T00:00:00.000Z"),
      endsAt: new Date("2026-07-18T00:00:00.000Z"),
      tierId: "00000000-0000-4000-8000-000000000001",
    });

    expect(snapshot).toEqual({
      status: "active",
      startsAt: "2026-06-18T00:00:00.000Z",
      endsAt: "2026-07-18T00:00:00.000Z",
      tierId: "00000000-0000-4000-8000-000000000001",
    });
    expect(snapshot).not.toHaveProperty("note");
    expect(snapshot).not.toHaveProperty("userId");
  });
});
