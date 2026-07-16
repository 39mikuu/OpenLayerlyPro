import { HeartHandshake, Sparkles } from "lucide-react";

import type { Translate } from "@/modules/i18n";
import type { SupporterWallViewModel } from "@/modules/supporter-wall";

export function SupporterWall({ view, t }: { view: SupporterWallViewModel; t: Translate }) {
  return (
    <div className="space-y-8">
      <header className="rounded-2xl border bg-card p-6 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-8">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-pink-50 text-pink-600 dark:bg-pink-950/40 dark:text-pink-300">
            <HeartHandshake className="size-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t("supporters.title")}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("supporters.subtitle")}
            </p>
          </div>
        </div>
      </header>

      {view.supporters.length === 0 ? (
        <section className="rounded-xl border border-dashed p-8 text-center">
          <Sparkles className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{t("supporters.empty")}</p>
        </section>
      ) : (
        <section className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          {view.supporters.map((supporter, index) => (
            <article
              key={`${supporter.displayName}-${supporter.tierName}-${index}`}
              className="min-w-0 rounded-xl border bg-card p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
            >
              <p className="[overflow-wrap:anywhere] text-lg font-semibold">
                {supporter.displayName}
              </p>
              <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {supporter.tierName}
              </p>
              {supporter.dedication ? (
                <p className="mt-4 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6">
                  {supporter.dedication}
                </p>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">{t("supporters.noDedication")}</p>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
