/* eslint-disable @next/next/no-html-link-for-pages -- entering or leaving the private area must reload its document policy */
import { ArrowUpRight, Rss, Search } from "lucide-react";
import Link from "next/link";

import { LogoutButton } from "@/components/auth/logout-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import type { getBlogCopy } from "@/modules/blog/copy";
import type { Translate } from "@/modules/i18n";
import type { SiteChromeView } from "@/modules/theme/types";

type Copy = ReturnType<typeof getBlogCopy>;

export function PersonalBlogChrome({
  view,
  t,
  copy,
  inside,
  readerHasAccess,
  children,
}: {
  view: SiteChromeView;
  t: Translate;
  copy: Copy;
  inside: boolean;
  readerHasAccess?: boolean;
  children: React.ReactNode;
}) {
  const links = !inside
    ? [{ href: "/posts", text: copy.archive }]
    : [
        ...(readerHasAccess
          ? [
              { href: "/inside", text: copy.inside },
              { href: "/inside/tiers", text: copy.plans },
            ]
          : []),
        ...(view.isLoggedIn
          ? [
              { href: "/inside/me/orders", text: copy.orders },
              { href: "/inside/me", text: copy.account },
            ]
          : []),
      ];
  return (
    <div className="site-theme min-h-screen bg-background text-foreground flex flex-col">
      <a
        href="#site-main"
        className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:m-3 focus:rounded focus:bg-background focus:p-3"
      >
        {t("nav.skipToContent")}
      </a>
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
          <a
            href="/"
            className="flex min-w-0 max-w-full items-center gap-2 font-semibold tracking-tight"
          >
            {view.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={view.logoUrl}
                alt=""
                width={26}
                height={26}
                className="size-[26px] shrink-0 rounded object-contain"
              />
            )}
            <span className="truncate">{view.siteName}</span>
          </a>
          <nav
            aria-label={inside ? copy.inside : copy.archive}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
          >
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="py-2 text-muted-foreground hover:text-foreground"
              >
                {link.text}
              </a>
            ))}
            {!inside && (
              <a
                href="/feed.xml"
                className="inline-flex items-center gap-1 py-2 text-muted-foreground hover:text-foreground"
              >
                <Rss className="size-4" aria-hidden />
                {copy.rss}
              </a>
            )}
            <ThemeToggle />
            {inside && <LocaleSwitcher />}
            {inside && view.isLoggedIn && <LogoutButton />}
          </nav>
        </div>
      </header>
      <main
        id="site-main"
        tabIndex={-1}
        className="mx-auto w-full max-w-5xl flex-1 px-4 py-7 sm:px-8 sm:py-12"
      >
        {children}
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:px-8">
          <span>{view.artistName || view.siteName}</span>
          <div className="flex flex-wrap gap-4">
            {view.socialLinks.map((link) => (
              <a
                key={link.url}
                href={link.url}
                rel="noopener noreferrer"
                target="_blank"
                className="inline-flex items-center gap-1 hover:underline"
              >
                {link.name}
                <ArrowUpRight className="size-3" aria-hidden />
              </a>
            ))}
          </div>
          {view.customFooterMarkup && (
            <div className="w-full" dangerouslySetInnerHTML={{ __html: view.customFooterMarkup }} />
          )}
        </div>
      </footer>
    </div>
  );
}

export function BlogSearch({
  copy,
  value,
  action = "/posts",
}: {
  copy: Copy;
  value?: string;
  action?: string;
}) {
  return (
    <form action={action} method="get" className="flex items-center gap-2">
      <label htmlFor="blog-search" className="sr-only">
        {copy.search}
      </label>
      <input
        id="blog-search"
        maxLength={120}
        name="q"
        type="search"
        defaultValue={value}
        placeholder={copy.search}
        className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
      />
      <button aria-label={copy.search} className="rounded-md border p-2.5 hover:bg-muted">
        <Search className="size-4" aria-hidden />
      </button>
    </form>
  );
}

export function ReaderCard({
  title,
  summary,
  href,
  date,
  image,
}: {
  title: string;
  summary: string | null;
  href: string;
  date: Date | null;
  image?: string | null;
}) {
  return (
    <article className="border-b py-5 last:border-b-0">
      <Link
        href={href}
        className="group flex min-w-0 items-start justify-between gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        <div className="min-w-0">
          {date && (
            <time dateTime={date.toISOString()} className="font-mono text-xs text-muted-foreground">
              {date.toISOString().slice(0, 10)}
            </time>
          )}
          <h2 className="mt-1 break-words text-lg font-semibold tracking-tight group-hover:underline">
            {title}
          </h2>
          {summary && (
            <p className="mt-1 line-clamp-3 break-words text-sm leading-6 text-muted-foreground">
              {summary}
            </p>
          )}
        </div>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt=""
            loading="lazy"
            decoding="async"
            className="aspect-[4/3] w-20 shrink-0 rounded-md border object-cover sm:w-32"
          />
        )}
      </Link>
    </article>
  );
}
