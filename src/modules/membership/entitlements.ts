import { ApiError } from "@/lib/api";
import type { Translate } from "@/modules/i18n";
import { ENTITLEMENT_KEYS, type EntitlementKey } from "@/modules/membership/entitlement-keys";

export { ENTITLEMENT_KEYS, type EntitlementKey } from "@/modules/membership/entitlement-keys";

const ENTITLEMENT_KEY_SET = new Set<string>(ENTITLEMENT_KEYS);

export function isEntitlementKey(value: string): value is EntitlementKey {
  return ENTITLEMENT_KEY_SET.has(value);
}

/** Submitted tier configuration is rejected when any key is not Core-owned. */
export function validateEntitlements(values: readonly string[]): EntitlementKey[] {
  if (values.some((value) => !isEntitlementKey(value))) {
    throw new ApiError(400, "unknownEntitlement");
  }
  return ENTITLEMENT_KEYS.filter((key) => values.includes(key));
}

/** Existing malformed rows grant nothing: authorization and display both fail closed. */
export function resolveStoredEntitlements(values: unknown): EntitlementKey[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || !isEntitlementKey(value))
  ) {
    return [];
  }
  return validateEntitlements(values);
}

export function describeEntitlements(values: unknown, t: Translate) {
  return resolveStoredEntitlements(values).map((key) => ({
    key,
    label: t(`entitlements.${key}.label`),
    description: t(`entitlements.${key}.description`),
  }));
}
