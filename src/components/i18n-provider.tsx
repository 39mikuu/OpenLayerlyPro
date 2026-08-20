"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";

import { installClientMessages } from "@/modules/i18n/client";
import { DEFAULT_LOCALE, type Locale } from "@/modules/i18n/config";
import type { Messages } from "@/modules/i18n/messages/zh";
import { type Translate, translateMessages } from "@/modules/i18n/runtime";

type I18nContextValue = { locale: Locale; messages: Messages | null };
const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  messages: null,
});

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages]);
  useEffect(() => {
    installClientMessages(messages);
    return () => installClientMessages(null);
  }, [messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

export function useT(): Translate {
  const messages = useContext(I18nContext).messages;
  return useMemo<Translate>(
    () => (key, params) => (messages ? translateMessages(messages, key, params) : key),
    [messages],
  );
}
