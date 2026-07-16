import type { Translate } from "@/modules/i18n";
import type { SupporterWallViewModel } from "@/modules/supporter-wall";

export function SupporterWall({ view, t }: { view: SupporterWallViewModel; t: Translate }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
      {/* The WordPress chrome already wraps page children in <main>; a nested
          main landmark is invalid, so this inner column is a plain section. */}
      <section className="min-w-0 space-y-6">
        <header className="border-b pb-5">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-primary">
            {t("supporters.eyebrow")}
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">{t("supporters.title")}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("supporters.subtitle")}</p>
        </header>

        {view.supporters.length === 0 ? (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            {t("supporters.empty")}
          </p>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            {view.supporters.map((supporter, index) => (
              <article
                key={`${supporter.displayName}-${supporter.tierName}-${index}`}
                className="min-w-0 rounded-lg border bg-card p-5"
              >
                <h2 className="[overflow-wrap:anywhere] font-bold">{supporter.displayName}</h2>
                <p className="mt-1 [overflow-wrap:anywhere] text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {supporter.tierName}
                </p>
                {supporter.dedication ? (
                  <p className="mt-4 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6">
                    {supporter.dedication}
                  </p>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {t("supporters.noDedication")}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <aside className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">
        <h2 className="font-bold text-foreground">{t("supporters.sidebarTitle")}</h2>
        <p className="mt-2 leading-6">{t("supporters.sidebarDescription")}</p>
      </aside>
    </div>
  );
}
