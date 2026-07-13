import {
  Bell,
  CalendarDays,
  FileText,
  HeartHandshake,
  Home,
  Mail,
  Newspaper,
  Sparkles,
  UserRound,
} from "lucide-react";
import Link from "next/link";

import { DisplayNameEditor } from "@/components/me/display-name-editor";
import { RenewalReminderToggle } from "@/components/membership/renewal-reminder-toggle";
import { NewPostEmailToggle } from "@/components/notifications/new-post-email-toggle";
import { SubscriptionCancelButton } from "@/components/payment/subscription-cancel-button";
import { SupporterWallControls } from "@/components/supporter-wall/supporter-wall-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import type { Translate } from "@/modules/i18n";
import type { MeView } from "@/modules/theme/types";

export function Me({ view, t }: { view: MeView; t: Translate }) {
  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <header className="border-b pb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("me.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("me.subtitle")}</p>
      </header>

      <section className="rounded-xl border bg-card p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-primary dark:bg-blue-950/40">
            <Mail className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{t("me.accountInfo")}</p>
            <p className="mt-1 truncate font-medium">{view.email}</p>
            <Badge variant="secondary" className="mt-2">
              {view.isAdmin ? t("me.roleAdmin") : t("me.roleFan")}
            </Badge>
          </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <UserRound className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("me.displayNameTitle")}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t("me.displayNameDescription")}
            </p>
            <div className="mt-4">
              <DisplayNameEditor displayName={view.displayName} />
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Bell className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold">{t("me.newPostEmailTitle")}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t("me.newPostEmailDescription")}
              </p>
            </div>
          </div>
          <div className="sm:text-right">
            <NewPostEmailToggle enabled={view.notificationPreferences.newPostEmailEnabled} />
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                view.notificationPreferences.newPostEmailEnabled
                  ? "me.newPostEmailOn"
                  : "me.newPostEmailOff",
              )}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-pink-50 text-pink-700 dark:bg-pink-950/40 dark:text-pink-300">
            <HeartHandshake className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("me.supporterWallTitle")}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t("me.supporterWallDescription")}
            </p>
            <div className="mt-4">
              <SupporterWallControls
                displayName={view.displayName}
                initialEntry={view.supporterWall.entry}
                settings={view.supporterWall.settings}
              />
            </div>
          </div>
        </div>
      </section>

      {view.membership ? (
        <section className="rounded-xl border border-blue-100 bg-blue-50/40 p-5 dark:border-blue-900 dark:bg-blue-950/15 sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">{t("me.memberStatus")}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{view.membership.tierName}</h2>
                <Badge>{t("me.active")}</Badge>
              </div>
              <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <CalendarDays className="size-4" />
                {t("me.validUntil", { date: formatDate(view.membership.endsAt) })}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <Button asChild>
                <a href="/tiers">{t("me.renew")}</a>
              </Button>
              <RenewalReminderToggle
                tierId={view.membership.tierId}
                enabled={view.membership.renewalReminderEnabled}
              />
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-xl border border-pink-100 bg-pink-50/40 p-5 dark:border-pink-900 dark:bg-pink-950/15 sm:p-6">
          <Sparkles className="size-5 text-pink-600 dark:text-pink-300" />
          <h2 className="mt-3 font-semibold">{t("me.noMemberTitle")}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("me.noMember")}</p>
          <Button className="mt-4" asChild>
            <a href="/tiers">{t("me.open")}</a>
          </Button>
        </section>
      )}

      {view.subscription && (
        <section className="rounded-xl border bg-card p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                {t("me.subscriptionStatus")}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{view.subscription.tierName}</h2>
                <Badge variant={view.subscription.status === "past_due" ? "secondary" : "default"}>
                  {t(`me.subscription${view.subscription.status}`)}
                </Badge>
              </div>
              {view.subscription.currentPeriodEndsAt && (
                <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                  <CalendarDays className="size-4" />
                  {t(
                    view.subscription.cancelAtPeriodEnd
                      ? "me.subscriptionEndsOn"
                      : "me.subscriptionRenewsOn",
                    {
                      date: formatDate(view.subscription.currentPeriodEndsAt),
                    },
                  )}
                </p>
              )}
            </div>
            {!view.subscription.cancelAtPeriodEnd &&
              (view.subscription.status === "active" ||
                view.subscription.status === "past_due") && (
                <SubscriptionCancelButton subscriptionId={view.subscription.id} />
              )}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-semibold">{t("me.quickLinks")}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {[
            { href: "/me/orders", label: t("me.myOrders"), icon: FileText },
            { href: "/tiers", label: t("nav.tiers"), icon: Sparkles },
            { href: "/posts", label: t("nav.posts"), icon: Newspaper },
            { href: "/", label: t("nav.home"), icon: Home },
          ].map((item) => {
            const content = (
              <>
                <item.icon className="size-4" />
                {item.label}
              </>
            );
            const className =
              "flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm font-medium transition hover:border-primary/30 hover:text-primary";
            return item.href === "/me/orders" ? (
              <Link key={item.href} href={item.href} className={className}>
                {content}
              </Link>
            ) : (
              <a key={item.href} href={item.href} className={className}>
                {content}
              </a>
            );
          })}
        </div>
      </section>
    </div>
  );
}
