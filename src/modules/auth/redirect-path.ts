export const MAGIC_LINK_REDIRECT_MAX_LENGTH = 512;

/** Allow only a same-site path and remove query and fragment before redirecting. */
export function normalizeMagicLinkRedirectPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  if (withoutQuery.length === 0 || withoutQuery.length > MAGIC_LINK_REDIRECT_MAX_LENGTH) {
    return null;
  }
  if (!withoutQuery.startsWith("/")) return null;
  if (withoutQuery.startsWith("//") || withoutQuery.startsWith("/\\")) return null;
  // Browsers reinterpret backslashes as slashes; reject whitespace and controls too.
  if (/[\u0000-\u001f\u007f\\\s]/.test(withoutQuery)) return null;
  return withoutQuery;
}

/** Prefix an already validated app path for APP_URL subpath deployments. */
export function withSiteBasePath(path: unknown, basePath?: unknown): string {
  const target = normalizeMagicLinkRedirectPath(path) ?? "/me";
  const base = normalizeMagicLinkRedirectPath(basePath);
  return base && base !== "/" ? `${base.replace(/\/+$/, "")}${target}` : target;
}

export function resolveSignedInLoginPath(
  role: "admin" | "member",
  adminLogin: boolean,
  next: unknown,
): string {
  if (adminLogin) return role === "admin" ? "/admin" : "/me";
  const target = normalizeMagicLinkRedirectPath(next);
  if (role !== "admin" && (target === "/admin" || target?.startsWith("/admin/"))) {
    return "/me";
  }
  return target ?? "/me";
}
