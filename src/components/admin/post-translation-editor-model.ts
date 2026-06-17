import type { Locale } from "@/modules/i18n";

export type TranslationVersion = {
  id: string;
  locale: string;
  title: string;
  summary: string | null;
  body: string | null;
  status: "draft" | "published" | "archived";
  source: "manual" | "machine";
  updatedAt: string;
};

export type TranslationEditorStatus = "untranslated" | "draft" | "published" | "machineDraft";

export function translationLocales(
  supportedLocales: readonly Locale[],
  originalLocale: string,
): Locale[] {
  return supportedLocales.filter((locale) => locale !== originalLocale);
}

export function translationVersionsForLocale(
  translations: TranslationVersion[],
  locale: Locale,
): { draft: TranslationVersion | null; published: TranslationVersion | null } {
  const versions = translations.filter((translation) => translation.locale === locale);
  return {
    draft: versions.find((translation) => translation.status === "draft") ?? null,
    published: versions.find((translation) => translation.status === "published") ?? null,
  };
}

export function translationEditorStatus(
  versions: ReturnType<typeof translationVersionsForLocale>,
): TranslationEditorStatus {
  if (versions.draft?.source === "machine") return "machineDraft";
  if (versions.draft) return "draft";
  if (versions.published) return "published";
  return "untranslated";
}

export function editableTranslation(versions: ReturnType<typeof translationVersionsForLocale>): {
  title: string;
  summary: string;
  body: string;
} {
  const source = versions.draft ?? versions.published;
  return {
    title: source?.title ?? "",
    summary: source?.summary ?? "",
    body: source?.body ?? "",
  };
}

export function hasPublishableTitle(title: string): boolean {
  return title.trim().length > 0;
}
