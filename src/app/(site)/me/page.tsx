import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/modules/auth/session";
import { canEnterInside } from "@/modules/blog/access";
import { requireInsidePage } from "@/modules/blog/reader-page";
import { getT } from "@/modules/i18n/server";
import { getActiveMembership } from "@/modules/membership";
import { describeEntitlements } from "@/modules/membership/entitlements";
import { getManualReminderTiers } from "@/modules/membership/renewal-reminders";
import { getNotificationPreference } from "@/modules/notifications";
import { getCurrentStripeSubscription } from "@/modules/payment/subscriptions";
import { getMyWallEntry, getSupporterWallSettings } from "@/modules/supporter-wall";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function MePage() {
  const readerArea = getEnv().PERSONAL_BLOG_MODE;
  const user = readerArea ? await requireInsidePage("/inside/me", false) : await getCurrentUser();
  if (!user) redirect("/login");
  const canSubscribe = !readerArea || (await canEnterInside(user));
  const [
    active,
    subscription,
    reminderTiers,
    notificationPreferences,
    supporterWallEntry,
    supporterWallSettings,
    theme,
    t,
  ] = await Promise.all([
    getActiveMembership(user.id),
    getCurrentStripeSubscription(user.id),
    getManualReminderTiers(user.id),
    getNotificationPreference(user.id),
    getMyWallEntry(user.id),
    getSupporterWallSettings(),
    getActiveTheme(),
    getT(),
  ]);
  const Me = theme.components.Me;
  return (
    <Me
      t={t}
      view={{
        readerArea,
        canSubscribe,
        email: user.email,
        displayName: user.displayName,
        isAdmin: user.role === "admin",
        supporterWall: {
          settings: supporterWallSettings,
          entry: supporterWallEntry
            ? {
                id: supporterWallEntry.id,
                dedication: supporterWallEntry.dedication,
                status: supporterWallEntry.status,
                version: supporterWallEntry.version,
              }
            : null,
        },
        notificationPreferences,
        membership: active
          ? {
              tierId: active.tier.id,
              tierName: active.tier.name,
              endsAt: active.membership.endsAt,
              renewalReminderEnabled: reminderTiers.has(active.tier.id),
              entitlements: describeEntitlements(active.tier.entitlements, t),
            }
          : null,
        subscription: subscription
          ? {
              id: subscription.subscription.id,
              status: subscription.subscription.status,
              tierName: subscription.tier.name,
              currentPeriodEndsAt: subscription.subscription.currentPeriodEndsAt,
              cancelAtPeriodEnd: subscription.subscription.cancelAtPeriodEnd,
            }
          : null,
      }}
    />
  );
}
