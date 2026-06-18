import { describe, expect, it } from "vitest";

import { evaluateTransition } from "./index";

const now = new Date("2026-06-18T00:00:00.000Z");

function membership(
  status: "active" | "suspended" | "revoked",
  overrides: Partial<{ startsAt: Date; endsAt: Date }> = {},
) {
  return {
    status,
    startsAt: overrides.startsAt ?? new Date("2026-06-17T00:00:00.000Z"),
    endsAt: overrides.endsAt ?? new Date("2026-06-19T00:00:00.000Z"),
  };
}

describe("membership lifecycle transitions", () => {
  it("allows active memberships to suspend, revoke, and extend", () => {
    expect(evaluateTransition(membership("active"), "suspend", now)).toEqual({ ok: true });
    expect(evaluateTransition(membership("active"), "revoke", now)).toEqual({ ok: true });
    expect(evaluateTransition(membership("active"), "extend", now)).toEqual({ ok: true });
  });

  it("allows suspended memberships to resume, revoke, and extend without restoring them", () => {
    expect(evaluateTransition(membership("suspended"), "resume", now)).toEqual({ ok: true });
    expect(evaluateTransition(membership("suspended"), "revoke", now)).toEqual({ ok: true });
    expect(evaluateTransition(membership("suspended"), "extend", now)).toEqual({ ok: true });
  });

  it("rejects commands whose target state is already stored", () => {
    expect(evaluateTransition(membership("suspended"), "suspend", now)).toEqual({
      ok: false,
      errorCode: "alreadyInState",
    });
    expect(evaluateTransition(membership("active"), "resume", now)).toEqual({
      ok: false,
      errorCode: "alreadyInState",
    });
    expect(evaluateTransition(membership("revoked"), "revoke", now)).toEqual({
      ok: false,
      errorCode: "alreadyInState",
    });
  });

  it("treats revoked as terminal", () => {
    for (const action of ["suspend", "resume", "extend"] as const) {
      expect(evaluateTransition(membership("revoked"), action, now)).toEqual({
        ok: false,
        errorCode: "invalidMembershipTransition",
      });
    }
  });

  it("rejects extending expired memberships", () => {
    const expired = { endsAt: now };
    expect(evaluateTransition(membership("active", expired), "extend", now)).toEqual({
      ok: false,
      errorCode: "invalidMembershipTransition",
    });
    expect(evaluateTransition(membership("suspended", expired), "extend", now)).toEqual({
      ok: false,
      errorCode: "invalidMembershipTransition",
    });
  });

  it("allows lifecycle changes for scheduled memberships", () => {
    const scheduled = {
      startsAt: new Date("2026-06-20T00:00:00.000Z"),
      endsAt: new Date("2026-07-20T00:00:00.000Z"),
    };
    expect(evaluateTransition(membership("active", scheduled), "suspend", now)).toEqual({
      ok: true,
    });
    expect(evaluateTransition(membership("active", scheduled), "extend", now)).toEqual({
      ok: true,
    });
  });

  it("allows state-only changes after expiration", () => {
    const expired = { endsAt: new Date("2026-06-17T00:00:00.000Z") };
    expect(evaluateTransition(membership("active", expired), "suspend", now)).toEqual({
      ok: true,
    });
    expect(evaluateTransition(membership("suspended", expired), "resume", now)).toEqual({
      ok: true,
    });
    expect(evaluateTransition(membership("active", expired), "revoke", now)).toEqual({
      ok: true,
    });
  });
});
