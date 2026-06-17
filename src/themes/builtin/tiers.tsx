import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { TiersView } from "@/modules/theme/types";

export function Tiers({ view, t }: { view: TiersView; t: Translate }) {
  return (
    <div className="space-y-8">
      <header className="border-b pb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("tiers.title")}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t("tiers.subtitle")}
        </p>
        {view.activeMembership && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("tiers.currentPrefix")}</span>
            <Badge>{view.activeMembership.tierName}</Badge>
            <span className="text-muted-foreground">
              {t("tiers.validUntil", {
                date: view.activeMembership.endsAt.toISOString().slice(0, 10),
              })}
            </span>
          </div>
        )}
      </header>

      {view.tiers.length === 0 ? (
        <p className="rounded-xl border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
          {t("tiers.empty")}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-4">
          {view.tiers.map((tier) => (
            <article
              key={tier.id}
              className="flex min-h-72 flex-col rounded-xl border bg-card p-5 text-card-foreground shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
            >
              <h2 className="font-semibold">{tier.name}</h2>
              <p className="mt-3 text-2xl font-bold tracking-tight text-primary">
                {tier.priceLabel}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("tiers.duration", { days: tier.durationDays })}
              </p>
              <div className="mt-5 flex-1 text-sm leading-6 text-muted-foreground">
                <p className="whitespace-pre-wrap">
                  {tier.description || t("tiers.descriptionFallback")}
                </p>
              </div>
              {tier.purchaseEnabled ? (
                <Button className="mt-5 w-full" asChild>
                  <Link href={view.isLoggedIn ? `/checkout/${tier.id}` : "/login"}>
                    {view.isLoggedIn ? t("tiers.open") : t("tiers.loginToOpen")}
                  </Link>
                </Button>
              ) : (
                <Button className="mt-5 w-full" variant="outline" disabled>
                  {t("tiers.notPurchasable")}
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
