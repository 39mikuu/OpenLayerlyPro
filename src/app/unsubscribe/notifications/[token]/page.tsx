import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { getEnv } from "@/lib/env";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import { getT } from "@/modules/i18n/server";
import { verifyNotificationUnsubscribeToken } from "@/modules/notifications";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function NotificationUnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [{ token }, t] = await Promise.all([params, getT()]);
  const verification = await verifyNotificationUnsubscribeToken(token);
  const valid = verification.valid;
  // Absolute URLs via buildPublicUrl keep an APP_URL path prefix; a root-
  // relative action or href would escape a /base-scoped reverse proxy.
  const publicBaseUrl = getPublicBaseUrl(getEnv().APP_URL);
  const unsubscribeAction = buildPublicUrl(publicBaseUrl, "/api/notifications/unsubscribe");
  const homeHref = buildPublicUrl(publicBaseUrl, "/");

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-12">
      <section className="rounded-xl border bg-card p-6 shadow-sm">
        <p className="text-sm font-medium text-muted-foreground">
          {t("unsubscribe.notifications.eyebrow")}
        </p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">
          {valid
            ? t("unsubscribe.notifications.confirmTitle")
            : t("unsubscribe.notifications.invalidTitle")}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {valid
            ? t("unsubscribe.notifications.confirmDescription")
            : t("unsubscribe.notifications.invalidDescription")}
        </p>
        {valid ? (
          <form className="mt-6" action={unsubscribeAction} method="post">
            <input type="hidden" name="token" value={token} />
            <Button type="submit">{t("unsubscribe.notifications.confirmAction")}</Button>
          </form>
        ) : (
          <Button className="mt-6" asChild>
            <Link href={homeHref}>{t("unsubscribe.notifications.homeAction")}</Link>
          </Button>
        )}
      </section>
    </main>
  );
}
