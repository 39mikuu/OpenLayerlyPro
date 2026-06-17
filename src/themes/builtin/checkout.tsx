import { Check, Clock3, ReceiptText } from "lucide-react";

import { CheckoutForm } from "@/components/payment/checkout-form";
import type { Translate } from "@/modules/i18n";
import type { CheckoutView } from "@/modules/theme/types";

export function Checkout({ view, t }: { view: CheckoutView; t: Translate }) {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="border-b pb-6">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("checkout.title", { tier: view.tier.name })}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t("checkout.manualReviewIntro")}
        </p>
      </header>

      <section className="rounded-xl border bg-card p-5 text-card-foreground shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("checkout.tierSummary")}
            </p>
            <h2 className="mt-2 text-xl font-semibold">{view.tier.name}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t("checkout.reviewNotice")}
            </p>
          </div>
          <div className="shrink-0 sm:text-right">
            <p className="text-2xl font-bold tracking-tight text-primary">{view.tier.priceLabel}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("tiers.duration", { days: view.tier.durationDays })}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-start gap-2 rounded-lg border border-pink-100 bg-pink-50/60 px-3 py-2.5 text-sm text-pink-800 dark:border-pink-900 dark:bg-pink-950/20 dark:text-pink-200">
          <Clock3 className="mt-0.5 size-4 shrink-0" />
          <span>{t("checkout.activationNotice")}</span>
        </div>
      </section>

      <section aria-labelledby="checkout-steps-title">
        <h2 id="checkout-steps-title" className="text-base font-semibold">
          {t("checkout.stepsTitle")}
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {[t("checkout.stepChoose"), t("checkout.stepPay"), t("checkout.stepUpload")].map(
            (label, index) => (
              <li
                key={label}
                className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-primary dark:bg-blue-950/40">
                  {index + 1}
                </span>
                <span className="text-sm font-medium">{label}</span>
              </li>
            ),
          )}
        </ol>
      </section>

      <section className="space-y-5 border-t pt-8">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-primary dark:bg-blue-950/40">
            <ReceiptText className="size-4" />
          </span>
          <div>
            <h2 className="font-semibold">{t("checkout.paymentSectionTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("checkout.paymentSectionHint")}</p>
          </div>
        </div>

        <CheckoutForm tierId={view.tier.id} methods={view.methods} />
      </section>

      <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
        <Check className="size-3.5" />
        {t("checkout.manualOnly")}
      </p>
    </div>
  );
}
