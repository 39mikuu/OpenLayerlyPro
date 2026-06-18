import { describe, expect, it } from "vitest";

import { getMembershipAdminActions, getMembershipDisplayState } from "./admin-model";

const now = new Date("2026-06-18T12:00:00.000Z");

function membership(status: "active" | "suspended" | "revoked", startsAt: string, endsAt: string) {
  return { status, startsAt, endsAt };
}

describe("membership admin model", () => {
  it.each([
    ["active", membership("active", "2026-06-01", "2026-07-01"), "active"],
    ["scheduled", membership("active", "2026-06-20", "2026-07-20"), "scheduled"],
    ["expired", membership("active", "2026-05-01", "2026-06-01"), "expired"],
    ["suspended", membership("suspended", "2026-06-01", "2026-07-01"), "suspended"],
    ["revoked", membership("revoked", "2026-06-01", "2026-07-01"), "revoked"],
  ] as const)("derives the %s display state", (_label, record, expected) => {
    expect(getMembershipDisplayState(record, now)).toBe(expected);
  });

  it.each([
    [
      "active current",
      membership("active", "2026-06-01", "2026-07-01"),
      ["suspend", "revoke", "extend"],
    ],
    [
      "active scheduled",
      membership("active", "2026-06-20", "2026-07-20"),
      ["suspend", "revoke", "extend"],
    ],
    ["active expired", membership("active", "2026-05-01", "2026-06-01"), ["revoke"]],
    [
      "suspended current",
      membership("suspended", "2026-06-01", "2026-07-01"),
      ["resume", "revoke", "extend"],
    ],
    [
      "suspended expired",
      membership("suspended", "2026-05-01", "2026-06-01"),
      ["resume", "revoke"],
    ],
    ["revoked", membership("revoked", "2026-06-01", "2026-07-01"), []],
  ] as const)("exposes only legal actions for %s", (_label, record, expected) => {
    expect(getMembershipAdminActions(record, now)).toEqual(expected);
  });
});
