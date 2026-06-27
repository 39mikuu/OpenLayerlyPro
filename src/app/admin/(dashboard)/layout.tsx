/* eslint-disable @next/next/no-html-link-for-pages -- leaving admin must establish a new public CSP document */
import Link from "next/link";
import { redirect } from "next/navigation";

import { LogoutButton } from "@/components/auth/logout-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { isInitialized } from "@/modules/site";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/admin", key: "overview" },
  { href: "/admin/account", key: "account" },
  { href: "/admin/site", key: "site" },
  { href: "/admin/tiers", key: "tiers" },
  { href: "/admin/posts", key: "posts" },
  { href: "/admin/taxonomy", key: "taxonomy" },
  { href: "/admin/translations", key: "translations" },
  { href: "/admin/files", key: "files" },
  { href: "/admin/users", key: "users" },
  { href: "/admin/memberships", key: "memberships" },
  { href: "/admin/payments/methods", key: "paymentMethods" },
  { href: "/admin/payments/reviews", key: "paymentReviews" },
  { href: "/admin/downloads", key: "downloads" },
  { href: "/admin/tasks", key: "tasks" },
  { href: "/admin/settings", key: "settings" },
  { href: "/admin/system", key: "system" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isInitialized())) redirect("/admin/setup");
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/login?admin=1");
  const t = await getT();

  return (
    <div className="min-h-screen flex">
      <aside className="w-48 border-r shrink-0 flex flex-col">
        <div className="h-14 border-b flex items-center px-4 font-semibold">
          <Link href="/admin">{t("admin.title")}</Link>
        </div>
        <nav className="flex-1 py-2">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block px-4 py-2 text-sm hover:bg-accent"
            >
              {t(`admin.nav.${item.key}`)}
            </Link>
          ))}
        </nav>
        <div className="border-t p-3 space-y-2 text-xs text-muted-foreground">
          <p className="truncate">{user.email}</p>
          <LocaleSwitcher />
          <div className="flex gap-1">
            <a href="/" className="underline">
              {t("admin.viewSite")}
            </a>
          </div>
          <LogoutButton />
        </div>
      </aside>
      <main className="flex-1 p-6 overflow-x-auto">{children}</main>
    </div>
  );
}
