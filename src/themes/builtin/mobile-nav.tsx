"use client";

import { Home, Menu, Newspaper, Sparkles, UserRound } from "lucide-react";

import { LogoutButton } from "@/components/auth/logout-button";
import { useT } from "@/components/i18n-provider";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import type { SiteChromeView } from "@/modules/theme/types";

type MobileNavView = Pick<SiteChromeView, "isLoggedIn">;

export function MobileNav({ view }: { view: MobileNavView }) {
  const t = useT();
  const links = [
    { href: "/", label: t("nav.home"), icon: Home },
    { href: "/posts", label: t("nav.posts"), icon: Newspaper },
    { href: "/tiers", label: t("nav.tiers"), icon: Sparkles },
    {
      href: view.isLoggedIn ? "/me" : "/login",
      label: view.isLoggedIn ? t("nav.me") : t("nav.login"),
      icon: UserRound,
    },
  ];

  return (
    <details className="group relative sm:hidden">
      <summary className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md hover:bg-accent [&::-webkit-details-marker]:hidden">
        <Menu className="size-5" />
        <span className="sr-only">{t("nav.menu")}</span>
      </summary>
      <div className="absolute right-0 top-10 z-50 w-64 rounded-xl border bg-background p-2 shadow-lg">
        <nav className="space-y-1">
          {links.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-accent"
            >
              <item.icon className="size-4 text-muted-foreground" />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="mt-2 flex items-center justify-between gap-2 border-t px-2 pt-2">
          <LocaleSwitcher />
          <ThemeToggle />
        </div>
        {view.isLoggedIn && (
          <div className="mt-2 border-t pt-2">
            <LogoutButton />
          </div>
        )}
      </div>
    </details>
  );
}
