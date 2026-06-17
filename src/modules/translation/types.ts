import type { Locale } from "@/modules/i18n";

export type TranslationTargetLocale = Extract<Locale, "en" | "ja">;

export type TranslationRequest = {
  text: string;
  sourceLocale: Locale;
  targetLocale: TranslationTargetLocale;
};

export type TranslationProvider = {
  id: "openai-compatible";
  translate(input: TranslationRequest): Promise<string>;
};
