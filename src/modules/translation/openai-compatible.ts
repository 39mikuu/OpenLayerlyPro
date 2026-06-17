import { ApiError } from "@/lib/api";
import type { ResolvedTranslationConfig } from "@/modules/config";

import type { TranslationProvider, TranslationRequest } from "./types";

const TARGET_LANGUAGE_NAMES = {
  en: "English",
  ja: "Japanese",
} as const;

export function buildTranslationPrompt(input: TranslationRequest): string {
  return [
    `Translate the following content into ${TARGET_LANGUAGE_NAMES[input.targetLocale]}.`,
    "Preserve all Markdown syntax exactly.",
    "Preserve paragraph breaks and line breaks.",
    "Do not add, remove, summarize, or reinterpret any content.",
    "Return only the translated content. Do not explain your answer.",
    "",
    input.text,
  ].join("\n");
}

export function createOpenAiCompatibleProvider(
  config: Pick<ResolvedTranslationConfig, "apiKey" | "endpoint" | "model">,
  fetcher: typeof fetch = fetch,
): TranslationProvider {
  return {
    id: "openai-compatible",
    async translate(input) {
      if (!config.apiKey || !config.endpoint || !config.model) {
        throw new ApiError(400, "translationConfigIncomplete");
      }

      const response = await fetcher(`${config.endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You are a precise translation engine. Follow the user instructions exactly.",
            },
            { role: "user", content: buildTranslationPrompt(input) },
          ],
        }),
      });

      if (!response.ok) {
        throw new ApiError(502, "translationProviderFailed", {
          status: response.status,
        });
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new ApiError(502, "translationProviderInvalidResponse");
      }
      return content;
    },
  };
}
