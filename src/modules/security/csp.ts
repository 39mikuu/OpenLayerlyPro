import { EMBED_FRAME_SOURCES } from "@/modules/content/video-embed";

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export type SecurityCspMode = "auto" | "report-only" | "enforce";
export type EffectiveCspMode = "report-only" | "enforce";

export type CspSourceGroups = {
  script: readonly string[];
  image: readonly string[];
  media: readonly string[];
  connect: readonly string[];
  frame: readonly string[];
};

const NONCE = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseExactHttpsOrigin(value: string): string | null {
  try {
    if (!value || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hostname.includes("*") ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function exactHttpsOriginFromUrl(value: string): string | null {
  try {
    if (!value || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hostname.includes("*")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolveEffectiveCspMode(
  configured: SecurityCspMode,
  legacyNeedsMigration: boolean,
): EffectiveCspMode {
  if (configured === "report-only") return "report-only";
  if (configured === "enforce") return "enforce";
  return legacyNeedsMigration ? "report-only" : "enforce";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sourceList(values: readonly string[]): string {
  return uniqueSorted(values).join(" ");
}

export function buildContentSecurityPolicy(input: {
  nonce: string;
  production: boolean;
  upgradeInsecureRequests?: boolean;
  sources: CspSourceGroups;
}): string {
  if (!NONCE.test(input.nonce)) {
    throw new Error("Invalid CSP nonce");
  }

  const scriptSources = [
    "'self'",
    `'nonce-${input.nonce}'`,
    ...(input.production ? [] : ["'unsafe-eval'"]),
    TURNSTILE_ORIGIN,
    ...input.sources.script,
  ];
  const directives = [
    "default-src 'self'",
    `script-src ${sourceList(scriptSources)}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${sourceList(["'self'", "data:", ...input.sources.image])}`,
    `media-src ${sourceList(["'self'", ...input.sources.media])}`,
    "font-src 'self'",
    `connect-src ${sourceList(["'self'", TURNSTILE_ORIGIN, ...input.sources.connect])}`,
    `frame-src ${sourceList([...EMBED_FRAME_SOURCES, TURNSTILE_ORIGIN, ...input.sources.frame])}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(input.upgradeInsecureRequests ? ["upgrade-insecure-requests"] : []),
  ];
  return `${directives.join("; ")};`;
}

export const DOCUMENT_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

export const HSTS_HEADER_VALUE = "max-age=31536000; includeSubDomains";
