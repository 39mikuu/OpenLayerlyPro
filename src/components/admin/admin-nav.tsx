"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import type { AdminNavGroupKey, AdminNavItemKey } from "@/modules/admin/navigation";

export type AdminNavItemView = {
  key: AdminNavItemKey;
  href: string;
  label: string;
};

export type AdminNavGroupView = {
  key: AdminNavGroupKey;
  label: string;
  items: AdminNavItemView[];
};

export function AdminNav({
  activeHref,
  ariaLabel,
  groups,
  onNavigate,
}: {
  activeHref: string | null;
  ariaLabel: string;
  groups: AdminNavGroupView[];
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={ariaLabel} className="space-y-5 py-2">
      {groups.map((group) => (
        <section key={group.key} className="space-y-1" data-admin-nav-group={group.key}>
          <p className="px-3 text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const active = activeHref === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-accent font-medium text-accent-foreground",
                  )}
                  onClick={onNavigate}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </nav>
  );
}
