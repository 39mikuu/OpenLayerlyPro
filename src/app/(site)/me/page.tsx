import { redirect } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { getActiveMembership } from "@/modules/membership";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [active, theme, t] = await Promise.all([
    getActiveMembership(user.id),
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
          ? { tierName: active.tier.name, endsAt: active.membership.endsAt }
          : null,
      }}
    />
  );
}
