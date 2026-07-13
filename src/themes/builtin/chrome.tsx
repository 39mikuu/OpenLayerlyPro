/* eslint-disable @next/next/no-html-link-for-pages -- full navigation is required when CSP scopes can change */
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { LogoutButton } from "@/components/auth/logout-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { SiteChromeView } from "@/modules/theme/types";

import { MobileNav } from "./mobile-nav";

function avatarFallback(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "C";
}

function BrandMark({
  view,
  creatorName,
  compact = false,
}: {
  view: SiteChromeView;
  creatorName: string;
  compact?: boolean;
}) {
  if (view.logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={view.logoUrl}
        alt=""
        className={compact ? "max-h-7 max-w-32 object-contain" : "max-h-8 max-w-40 object-contain"}
      />
    );
  }
  if (view.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={view.avatarUrl}
        alt=""
        className="size-8 shrink-0 rounded-full border object-cover"
      />
    );
  }
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-bold text-blue-600 dark:bg-blue-950 dark:text-blue-300">
      {avatarFallback(creatorName)}
    </span>
  );
}

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
    <div className="site-theme flex min-h-screen flex-col bg-slate-50/50 text-foreground dark:bg-background">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex min-h-14 max-w-4xl items-center justify-between gap-3 px-4 py-2">
          <a href="/" className="flex min-w-0 items-center gap-2.5 font-semibold">
            <BrandMark view={view} creatorName={creatorName} />
            <span className="truncate">{creatorName}</span>
          </a>

          <nav className="hidden shrink-0 items-center gap-0.5 text-sm sm:flex">
            <Button variant="ghost" size="sm" className="hidden sm:inline-flex" asChild>
              <a href="/posts">{t("nav.posts")}</a>
            </Button>
            <Button variant="ghost" size="sm" className="hidden sm:inline-flex" asChild>
              <a href="/tiers">{t("nav.tiers")}</a>
            </Button>
            {view.supporterWallEnabled ? (
              <Button variant="ghost" size="sm" className="hidden sm:inline-flex" asChild>
                <a href="/supporters">{t("nav.supporters")}</a>
              </Button>
            ) : null}
            {view.isLoggedIn ? (
              <>
                <Button variant="ghost" size="sm" asChild>
                  <a href="/me">{t("nav.me")}</a>
                </Button>
                <LogoutButton />
              </>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <a href="/login">{t("nav.login")}</a>
              </Button>
            )}
            <ThemeToggle />
            <LocaleSwitcher />
          </nav>
          <MobileNav view={view} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:py-10">{children}</main>

      <footer className="border-t bg-background py-8">
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 px-4">
          {view.logoUrl ? <BrandMark view={view} creatorName={creatorName} compact /> : null}
          {view.socialLinks.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              {view.socialLinks.map((link) => (
                <Button key={link.url} variant="ghost" size="sm" asChild>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.name}
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} {creatorName}
          </p>
        </div>
        {view.customFooterMarkup ? (
          <div className="mx-auto mt-4 max-w-4xl px-4 text-center text-xs text-muted-foreground">
            <div dangerouslySetInnerHTML={{ __html: view.customFooterMarkup }} />
          </div>
        ) : null}
      </footer>
    </div>
  );
}
