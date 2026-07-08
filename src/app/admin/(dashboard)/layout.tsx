import { redirect } from "next/navigation";

import { AdminShell } from "@/components/admin/admin-shell";
import { adminNavGroups } from "@/modules/admin/navigation";
import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { isInitialized } from "@/modules/site";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isInitialized())) redirect("/admin/setup");
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/login?admin=1");
  const t = await getT();
  const navGroups = adminNavGroups.map((group) => ({
    key: group.key,
    label: t(group.labelKey),
    items: group.items.map((item) => ({
      key: item.key,
      href: item.href,
      label: t(item.labelKey),
    })),
  }));

  return (
    <AdminShell
      labels={{
        title: t("admin.title"),
        navigation: t("admin.shell.navigation"),
        openMenu: t("admin.shell.openMenu"),
        closeMenu: t("admin.shell.closeMenu"),
        menuTitle: t("admin.shell.menuTitle"),
        menuDescription: t("admin.shell.menuDescription"),
        skipToContent: t("admin.shell.skipToContent"),
        account: t("admin.shell.account"),
        viewSite: t("admin.viewSite"),
      }}
      navGroups={navGroups}
      userEmail={user.email}
    >
      {children}
    </AdminShell>
  );
}
