import type { Translate } from "@/modules/i18n";
import type { SupporterWallViewModel } from "@/modules/supporter-wall";

export function SupporterWall({ view, t }: { view: SupporterWallViewModel; t: Translate }) {
  return (
    <article className="space-y-8">
      <header className="border-b pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          {t("supporters.eyebrow")}
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">{t("supporters.title")}</h1>
        <p className="mt-3 leading-7 text-muted-foreground">{t("supporters.subtitle")}</p>
      </header>

      {view.supporters.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("supporters.empty")}</p>
      ) : (
        <div className="divide-y">
          {view.supporters.map((supporter, index) => (
            <section
              key={`${supporter.displayName}-${supporter.tierName}-${index}`}
              className="py-6"
            >
              <h2 className="text-xl font-semibold">{supporter.displayName}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{supporter.tierName}</p>
              {supporter.dedication ? (
                <p className="mt-4 whitespace-pre-wrap leading-7">{supporter.dedication}</p>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">{t("supporters.noDedication")}</p>
              )}
            </section>
          ))}
        </div>
      )}
    </article>
  );
}
