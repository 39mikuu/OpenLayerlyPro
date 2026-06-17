export const SUPPORTED_LOCALES = ["zh", "en", "ja"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh";

export const LOCALE_NAMES: Record<Locale, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
};

/** 访客语言偏好 cookie（仅偏好，不入 site_settings）。 */
export const LOCALE_COOKIE = "locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
