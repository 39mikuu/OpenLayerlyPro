import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { getActiveMembership } from "@/modules/membership";
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
  const user = await getCurrentUser();
  if (!user) redirect("/login");
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
