import { cookies, headers } from "next/headers";
import { cache } from "react";

import { DEFAULT_LOCALE, isLocale, type Locale, LOCALE_COOKIE } from "./config";
import { negotiateLocale, type Translate, translate } from "./translate";

/** 解析当前访客语言：cookie → Accept-Language 协商 → 默认。请求级缓存。 */
export const resolveLocale = cache(async (): Promise<Locale> => {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;
  const acceptLanguage = (await headers()).get("accept-language");
  return negotiateLocale(acceptLanguage) ?? DEFAULT_LOCALE;
});

/** 服务端翻译器：绑定当前请求的语言。请求级缓存。 */
export const getT = cache(async (): Promise<Translate> => {
  const locale = await resolveLocale();
  return (key, params) => translate(locale, key, params);
});
