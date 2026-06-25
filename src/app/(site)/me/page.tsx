import { redirect } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { getActiveMembership } from "@/modules/membership";
import { getManualReminderTiers } from "@/modules/membership/renewal-reminders";
import { getCurrentStripeSubscription } from "@/modules/payment/subscriptions";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [active, subscription, reminderTiers, theme, t] = await Promise.all([
    getActiveMembership(user.id),
    getCurrentStripeSubscription(user.id),
    getManualReminderTiers(user.id),
    getActiveTheme(),
    getT(),
  ]);
  const Me = theme.components.Me;
  return (
    <Me
      t={t}
      view={{
        email: user.email,
        isAdmin: user.role === "admin",
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
