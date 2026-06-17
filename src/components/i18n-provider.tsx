"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

import { DEFAULT_LOCALE, type Locale, type Translate, translate } from "@/modules/i18n";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT(): Translate {
  const locale = useLocale();
  return useMemo<Translate>(() => (key, params) => translate(locale, key, params), [locale]);
}
