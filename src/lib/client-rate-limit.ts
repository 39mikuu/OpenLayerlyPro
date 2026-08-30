import { ApiError } from "@/lib/api-error";

export type ClientRateLimitIdentity = { kind: "ip"; value: string } | { kind: "unresolved" };

const UNRESOLVED_WARNING_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_UNRESOLVED_WARNING_MESSAGE =
  "Trusted client IP is unavailable. Using operation-specific unresolved emergency rate-limit buckets; configure TRUSTED_PROXY_HEADER/TRUSTED_PROXY_HOPS for per-IP isolation.";

let lastUnresolvedWarningAt = Number.NEGATIVE_INFINITY;

export function resolveClientRateLimitIdentity(ip: string | null): ClientRateLimitIdentity {
  return ip ? { kind: "ip", value: ip } : { kind: "unresolved" };
}

export function assertProductionAuthClientIdentity(
  identity: ClientRateLimitIdentity,
  nodeEnv: string,
  operation: string,
): void {
  if (identity.kind !== "unresolved" || nodeEnv !== "production") return;
  warnUnresolvedClientRateLimitIdentity({
    message: `Trusted client IP is unavailable for ${operation}. Rejecting production authentication request; configure TRUSTED_PROXY_HEADER/TRUSTED_PROXY_HOPS.`,
  });
  throw new ApiError(503, "trustedClientIpUnavailable");
}

export function warnUnresolvedClientRateLimitIdentity(input?: {
  now?: number;
  warn?: (message: string) => void;
  message?: string;
}): boolean {
  const now = input?.now ?? Date.now();
  if (now - lastUnresolvedWarningAt < UNRESOLVED_WARNING_INTERVAL_MS) return false;
  lastUnresolvedWarningAt = now;
  (input?.warn ?? console.warn)(input?.message ?? DEFAULT_UNRESOLVED_WARNING_MESSAGE);
  return true;
}

export function __resetUnresolvedClientWarningForTests(): void {
  lastUnresolvedWarningAt = Number.NEGATIVE_INFINITY;
}
