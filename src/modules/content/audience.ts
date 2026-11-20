export type ContentVisibility = "public" | "login" | "member";

export function canReadPostAudience(
  visibility: ContentVisibility,
  audience: "guest" | "reader" | { level: number },
  requiredLevel: number | undefined,
): boolean {
  if (visibility === "public") return true;
  if (audience === "guest") return false;
  if (visibility === "login") return true;
  return (
    typeof audience === "object" && requiredLevel !== undefined && audience.level >= requiredLevel
  );
}
