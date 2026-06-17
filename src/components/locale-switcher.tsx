"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { useLocale, useT } from "@/components/i18n-provider";
import { type Locale, LOCALE_COOKIE, LOCALE_NAMES, SUPPORTED_LOCALES } from "@/modules/i18n";

export function LocaleSwitcher() {
  const router = useRouter();
  const current = useLocale();
  const t = useT();
  const [pending, startTransition] = useTransition();

  function setLocale(next: Locale) {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    void fetch("/api/me/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next }),
    }).finally(() => startTransition(() => router.refresh()));
  }

  return (
    <select
      aria-label={t("locale.label")}
      className="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
      value={current}
      disabled={pending}
      onChange={(event) => setLocale(event.target.value as Locale)}
    >
      {SUPPORTED_LOCALES.map((locale) => (
        <option key={locale} value={locale}>
          {LOCALE_NAMES[locale]}
        </option>
      ))}
    </select>
  );
}
