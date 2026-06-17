import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from "./config";
import { en } from "./messages/en";
import { ja } from "./messages/ja";
import { type Messages, zh } from "./messages/zh";

const MESSAGES: Record<Locale, Messages> = { zh, en, ja };

/** 翻译函数：点路径取 key，缺失回落默认语言再回落 key；`{name}` 插值。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

function getPath(obj: unknown, key: string): string | undefined {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in cur) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = getPath(MESSAGES[locale], key) ?? getPath(MESSAGES[DEFAULT_LOCALE], key) ?? key;
  return interpolate(raw, params);
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
