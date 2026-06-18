import { CircleCheck, Clock3, CreditCard, FileText, RotateCcw, XCircle } from "lucide-react";
import Link from "next/link";

import { OrderActions } from "@/components/payment/order-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import type { Translate } from "@/modules/i18n";
import type { MeOrdersView, OrderStatus } from "@/modules/theme/types";

type StatusMeta = {
  key: string;
  className: string;
  icon: typeof Clock3;
};

const STATUS: Record<OrderStatus, StatusMeta> = {
  pending_review: {
    key: "order.statusPending",
    className:
      "border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-900 dark:bg-pink-950/30 dark:text-pink-300",
    icon: Clock3,
  },
  approved: {
    key: "order.statusApproved",
    className:
      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300",
    icon: CircleCheck,
  },
  rejected: {
    key: "order.statusRejected",
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300",
    icon: XCircle,
  },
  cancelled: {
    key: "order.statusCancelled",
    className: "border-border bg-muted/50 text-muted-foreground",
    icon: RotateCcw,
  },
  reversed: {
    key: "order.statusReversed",
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300",
    icon: RotateCcw,
  },
};

export function MeOrders({ view, t }: { view: MeOrdersView; t: Translate }) {
  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <header className="border-b pb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("order.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("order.subtitle")}</p>
      </header>

      {view.orders.length === 0 ? (
        <section className="rounded-xl border border-dashed bg-card px-6 py-10 text-center">
          <FileText className="mx-auto size-7 text-muted-foreground" />
          <h2 className="mt-3 font-semibold">{t("order.noneTitle")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("order.none")}</p>
          <Button className="mt-5" asChild>
            <Link href="/tiers">{t("order.browseTiers")}</Link>
          </Button>
        </section>
      ) : (
        <div className="space-y-4">
          {view.orders.map((order) => {
            const status = STATUS[order.status];
            const StatusIcon = status.icon;
            return (
              <article
                key={order.id}
                className="rounded-xl border bg-card p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="font-semibold">{order.tierName}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("order.planMeta", {
                        amount: order.amountLabel,
                        days: order.durationDays,
                      })}
                    </p>
                  </div>
                  <Badge variant="outline" className={`w-fit gap-1 ${status.className}`}>
                    <StatusIcon className="size-3" />
                    {t(status.key)}
                  </Badge>
                </div>

                <dl className="mt-4 grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("order.paymentMethod")}</dt>
                    <dd className="mt-1 flex items-center gap-2 font-medium">
                      <CreditCard className="size-4 text-muted-foreground" />
                      {order.paymentMethodName ?? t("order.paymentMethodUnavailable")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("order.submittedAt")}</dt>
                    <dd className="mt-1 font-medium">{formatDateTime(order.createdAt)}</dd>
                  </div>
                </dl>

                {order.note && (
                  <div className="mt-4 rounded-lg bg-muted/40 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{t("order.submittedNote")}</span>
                    {order.note}
                  </div>
                )}

                {order.reviewNote && (
                  <div
                    className={`mt-4 rounded-lg px-3 py-2 text-sm ${
                      order.status === "rejected"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted/40"
                    }`}
                  >
                    <span className="font-medium">{t("order.reviewNote")}</span>
                    {order.reviewNote}
                  </div>
                )}

                <div className="mt-4">
                  <OrderActions requestId={order.id} status={order.status} />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
