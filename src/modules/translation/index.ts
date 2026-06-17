import { ApiError } from "@/lib/api";
import { getTranslationConfig } from "@/modules/config";

import { createOpenAiCompatibleProvider } from "./openai-compatible";
import type { TranslationProvider, TranslationRequest } from "./types";

export { buildTranslationPrompt, createOpenAiCompatibleProvider } from "./openai-compatible";
export type { TranslationProvider, TranslationRequest, TranslationTargetLocale } from "./types";

export async function getTranslationProvider(): Promise<TranslationProvider> {
  const config = await getTranslationConfig();
  if (!config.enabled) throw new ApiError(400, "translationDisabled");
  if (!config.configured) throw new ApiError(400, "translationConfigIncomplete");

  switch (config.provider) {
    case "openai-compatible":
      return createOpenAiCompatibleProvider(config);
  }
}

export async function translateContent(input: TranslationRequest): Promise<string> {
  const provider = await getTranslationProvider();
  return provider.translate(input);
}
