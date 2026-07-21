export const ENTITLEMENT_KEYS = [
  "early_access",
  "behind_the_scenes",
  "supporter_recognition",
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];
