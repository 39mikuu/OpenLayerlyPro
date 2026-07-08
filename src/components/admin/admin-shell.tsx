"use client";

import { Menu, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { AdminNav, type AdminNavGroupView } from "@/components/admin/admin-nav";
import { LogoutButton } from "@/components/auth/logout-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { matchAdminNavItem } from "@/modules/admin/navigation";

export type AdminShellLabels = {
  title: string;
  navigation: string;
  openMenu: string;
  closeMenu: string;
  menuTitle: string;
  menuDescription: string;
  skipToContent: string;
  account: string;
  viewSite: string;
};

function AccountActions({ labels, userEmail }: { labels: AdminShellLabels; userEmail: string }) {
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p className="truncate" title={userEmail}>
        {userEmail}
      </p>
      <LocaleSwitcher />
      <div>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- leaving admin must establish a new public CSP document */}
        <a
          href="/"
          className="underline underline-offset-4 hover:text-foreground"
          data-testid="admin-view-site-link"
        >
          {labels.viewSite}
        </a>
      </div>
      <LogoutButton />
    </div>
  );
}

export function AdminShell({
  children,
  labels,
  navGroups,
  userEmail,
}: {
  children: ReactNode;
  labels: AdminShellLabels;
  navGroups: AdminNavGroupView[];
  userEmail: string;
}) {
  const pathname = usePathname();
  const activeHref = matchAdminNavItem(pathname)?.href ?? null;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const shouldRestoreFocusRef = useRef(false);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1024px)");
    const closeDrawerForDesktop = (query: MediaQueryList | MediaQueryListEvent) => {
      if (!query.matches) return;
      shouldRestoreFocusRef.current = false;
      setMobileNavOpen(false);
    };

    closeDrawerForDesktop(desktopQuery);
    desktopQuery.addEventListener("change", closeDrawerForDesktop);
    return () => desktopQuery.removeEventListener("change", closeDrawerForDesktop);
  }, []);

  useEffect(() => {
    if (mobileNavOpen) {
      shouldRestoreFocusRef.current = true;
      return;
    }
    if (shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false;
      window.setTimeout(() => menuButtonRef.current?.focus(), 0);
    }
  }, [mobileNavOpen]);

  function focusMain(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const main = document.getElementById("admin-main");
    main?.focus();
    main?.scrollIntoView({ block: "start" });
  }

  return (
    <div className="min-h-dvh bg-background text-foreground lg:flex">
      <a
        href="#admin-main"
        className="sr-only z-[60] rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-none focus:ring-2 focus:ring-ring"
        onClick={focusMain}
      >
        {labels.skipToContent}
      </a>

      <aside
        className="hidden w-64 shrink-0 border-r bg-background lg:flex lg:min-h-dvh lg:flex-col"
        data-testid="admin-desktop-sidebar"
      >
        <div className="flex h-14 items-center border-b px-4 font-semibold">
          <Link href="/admin">{labels.title}</Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <AdminNav activeHref={activeHref} ariaLabel={labels.navigation} groups={navGroups} />
        </div>
        <div className="border-t p-3">
          <AccountActions labels={labels} userEmail={userEmail} />
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur lg:hidden">
          <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <button
              ref={menuButtonRef}
              type="button"
              className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={labels.openMenu}
              aria-expanded={mobileNavOpen}
              aria-controls="admin-mobile-navigation"
              data-testid="admin-mobile-menu-button"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="size-4" aria-hidden="true" />
            </button>
            <DialogContent
              id="admin-mobile-navigation"
              data-testid="admin-mobile-nav"
              className="left-0 top-0 flex h-dvh max-h-dvh w-80 max-w-[calc(100vw-2rem)] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-r p-0 shadow-xl sm:max-w-xs"
              showCloseButton={false}
            >
              <DialogHeader className="border-b px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <DialogTitle>{labels.menuTitle}</DialogTitle>
                    <DialogDescription>{labels.menuDescription}</DialogDescription>
                  </div>
                  <DialogClose
                    render={
                      <button
                        type="button"
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={labels.closeMenu}
                      />
                    }
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </DialogClose>
                </div>
              </DialogHeader>
              <div
                className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
                data-testid="admin-mobile-nav-scroll"
              >
                <AdminNav
                  activeHref={activeHref}
                  ariaLabel={labels.navigation}
                  groups={navGroups}
                  onNavigate={() => setMobileNavOpen(false)}
                />
              </div>
              <div className="border-t p-4" data-testid="admin-mobile-account-actions">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {labels.account}
                </p>
                <AccountActions labels={labels} userEmail={userEmail} />
              </div>
            </DialogContent>
          </Dialog>
          <Link href="/admin" className="min-w-0 truncate font-semibold">
            {labels.title}
          </Link>
        </header>

        <main
          id="admin-main"
          tabIndex={-1}
          className={cn(
            "min-w-0 flex-1 overflow-x-auto px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6 lg:p-6",
          )}
          data-testid="admin-main"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
