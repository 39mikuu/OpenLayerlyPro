import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from "./config";
import { en } from "./messages/en";
import { ja } from "./messages/ja";
import { type Messages, zh } from "./messages/zh";
import { mergeMessages, translateMessages } from "./runtime";

const MESSAGES: Record<Locale, Messages> = { zh, en, ja };
const CLIENT_MESSAGES: Record<Locale, Messages> = {
  zh,
  en: mergeMessages(zh, en),
  ja: mergeMessages(zh, ja),
};

/** 翻译函数：点路径取 key，缺失回落默认语言再回落 key；`{name}` 插值。 */
export type { Translate } from "./runtime";

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  return translateMessages(MESSAGES[locale], key, params, MESSAGES[DEFAULT_LOCALE]);
}

/** One effective catalog for the active locale; safe to serialize to the client boundary. */
export function getClientMessages(locale: Locale): Messages {
  return CLIENT_MESSAGES[locale];
}

/** 从 Accept-Language 协商出受支持的语言（精确或基础子标签匹配），无则返回 null。 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) return null;
  for (const part of acceptLanguage.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase();
    if (!tag) continue;
    const base = tag.split("-")[0];
    const hit = SUPPORTED_LOCALES.find((l) => l === tag || l === base);
    if (hit) return hit;
  }
  return null;
}
