import type { Membership } from "@/db/schema";

export type MembershipDisplayState = "active" | "scheduled" | "expired" | "suspended" | "revoked";

export type MembershipAdminAction = "suspend" | "resume" | "revoke" | "extend";

type MembershipStateInput = Pick<Membership, "status"> & {
  startsAt: Date | string;
  endsAt: Date | string;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function getMembershipDisplayState(
  membership: MembershipStateInput,
  now = new Date(),
): MembershipDisplayState {
  if (membership.status === "revoked") return "revoked";
  if (membership.status === "suspended") return "suspended";
  if (asDate(membership.endsAt) <= now) return "expired";
  if (asDate(membership.startsAt) > now) return "scheduled";
  return "active";
}

export function getMembershipAdminActions(
  membership: MembershipStateInput,
  now = new Date(),
): MembershipAdminAction[] {
  if (membership.status === "revoked") return [];
  const expired = asDate(membership.endsAt) <= now;
  if (membership.status === "suspended") {
    return expired ? ["resume", "revoke"] : ["resume", "revoke", "extend"];
  }
  if (expired) return ["revoke"];
  return ["suspend", "revoke", "extend"];
}
