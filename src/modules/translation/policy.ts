import type { PostTranslation } from "@/db/schema";
import type { ResolvedTranslationConfig } from "@/modules/config";

export function shouldShowMachineTranslationLabel(
  config: Pick<ResolvedTranslationConfig, "showMachineTranslationLabel">,
  source: PostTranslation["source"] | null,
): boolean {
  return config.showMachineTranslationLabel && source === "machine";
}
