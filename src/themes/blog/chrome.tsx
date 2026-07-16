/* eslint-disable @next/next/no-html-link-for-pages -- full navigation is required when CSP scopes can change */
import type { ReactNode } from "react";

import { LogoutButton } from "@/components/auth/logout-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import type { Translate } from "@/modules/i18n";
import type { SiteChromeView } from "@/modules/theme/types";

/**
 * 博客主题外壳：窄栏阅读宽度、文字优先的极简 header/footer。
 * 与内置主题遵守同一契约：只消费 view-model，保留 `.site-theme` 取色作用域
 * 与 customFooterMarkup 渲染位。
 */
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
      <header className="border-b">
        <div className="mx-auto flex min-h-14 w-full max-w-2xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
          <a href="/" className="min-w-0 truncate text-base font-bold tracking-tight">
            {creatorName}
          </a>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <a href="/posts" className="transition-colors hover:text-foreground">
              {t("nav.posts")}
            </a>
            <a href="/tiers" className="transition-colors hover:text-foreground">
              {t("nav.tiers")}
            </a>
            {view.supporterWallEnabled ? (
              <a href="/supporters" className="transition-colors hover:text-foreground">
                {t("nav.supporters")}
              </a>
            ) : null}
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
            <span className="flex items-center gap-0.5">
              <ThemeToggle />
              <LocaleSwitcher />
            </span>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10">{children}</main>

      <footer className="border-t py-8">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-2 px-5 text-center">
          {view.socialLinks.length > 0 && (
            <p className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
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
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} {creatorName}
          </p>
          {view.customFooterMarkup ? (
            <div className="mt-2 text-xs text-muted-foreground">
              <div dangerouslySetInnerHTML={{ __html: view.customFooterMarkup }} />
            </div>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
