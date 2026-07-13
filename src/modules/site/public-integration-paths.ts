export const PUBLIC_INTEGRATION_EXACT_PATHS = ["/", "/posts", "/tiers"] as const;
export const PUBLIC_INTEGRATION_PATH_PREFIXES = ["/posts/"] as const;

export function isPublicIntegrationDocument(pathname: string): boolean {
  return (
    PUBLIC_INTEGRATION_EXACT_PATHS.includes(
      pathname as (typeof PUBLIC_INTEGRATION_EXACT_PATHS)[number],
    ) || PUBLIC_INTEGRATION_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}
