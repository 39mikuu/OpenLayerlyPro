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
    "Preserve every OLP_MD_*_END token exactly, including its spelling and count.",
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

      // Parse the endpoint on its own before appending the path: a legacy
      // stored value with a query string would otherwise swallow the appended
      // path, and nothing may reach fetch with the Bearer key until the
      // endpoint has passed the same shape checks the save path enforces.
      let requestUrl: URL;
      try {
        requestUrl = new URL(config.endpoint);
      } catch {
        throw new ApiError(400, "translationEndpointInvalid");
      }
      if (
        (requestUrl.protocol !== "https:" && requestUrl.protocol !== "http:") ||
        requestUrl.username ||
        requestUrl.password ||
        requestUrl.search ||
        requestUrl.hash
      ) {
        throw new ApiError(400, "translationEndpointInvalid");
      }
      requestUrl.pathname = `${requestUrl.pathname.replace(/\/+$/, "")}/chat/completions`;

      const response = await fetcher(requestUrl.toString(), {
        method: "POST",
        // The Bearer key must never follow a redirect off the configured host.
        redirect: "error",
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
