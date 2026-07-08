/* eslint-disable @next/next/no-html-link-for-pages -- full navigation is required when CSP scopes can change */
import type { ReactNode } from "react";

import { LogoutButton } from "@/components/auth/logout-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import type { Translate } from "@/modules/i18n";
import type { SiteChromeView } from "@/modules/theme/types";

export function Chrome({
  view,
  t,
  children,
}: {
  view: SiteChromeView;
  t: Translate;
  children: ReactNode;
}) {
  const creatorName = view.artistName || view.siteName;

  return (
    <div className="site-theme flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <a href="/" className="flex min-w-0 items-center gap-3">
              {view.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={view.logoUrl}
                  alt={view.siteName}
                  className="size-11 rounded-xl object-contain"
                />
              ) : (
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary text-lg font-black text-primary-foreground shadow-sm">
                  {view.siteName.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-2xl font-black tracking-tight">
                  {view.siteName}
                </span>
                <span className="block truncate text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                  {creatorName}
                </span>
              </span>
            </a>
            <span className="flex items-center gap-1 rounded-full border bg-background px-2 py-1">
              <ThemeToggle />
              <LocaleSwitcher />
            </span>
          </div>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-3 text-sm font-medium text-muted-foreground">
            <a href="/posts" className="transition-colors hover:text-foreground">
              {t("nav.posts")}
            </a>
            <a href="/tiers" className="transition-colors hover:text-foreground">
              {t("nav.tiers")}
            </a>
            {view.isLoggedIn ? (
              <>
                <a href="/me" className="transition-colors hover:text-foreground">
                  {t("nav.me")}
                </a>
                <LogoutButton />
              </>
            ) : (
              <a href="/login" className="transition-colors hover:text-foreground">
                {t("nav.login")}
              </a>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:py-10">{children}</main>

      <footer className="border-t bg-card/60 py-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {creatorName}
          </p>
          {view.socialLinks.length > 0 && (
            <p className="flex flex-wrap gap-x-4 gap-y-1">
              {view.socialLinks.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {link.name}
                </a>
              ))}
            </p>
          )}
          {view.customFooterMarkup ? (
            <div className="text-xs">
              <div dangerouslySetInnerHTML={{ __html: view.customFooterMarkup }} />
            </div>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
