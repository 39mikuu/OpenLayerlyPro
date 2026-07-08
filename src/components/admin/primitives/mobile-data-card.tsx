import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ResponsiveDataView({
  cards,
  className,
  table,
}: {
  cards: ReactNode;
  className?: string;
  table: ReactNode;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      <div className="hidden md:block">{table}</div>
      <div data-slot="admin-mobile-data-list" className="grid gap-3 md:hidden">
        {cards}
      </div>
    </div>
  );
}

export function MobileDataCard({
  actions,
  children,
  className,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  eyebrow?: ReactNode;
  title: ReactNode;
}) {
  return (
    <article
      data-slot="admin-mobile-data-card"
      className={cn("rounded-lg border bg-card p-4 text-card-foreground shadow-xs", className)}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? <p className="text-xs font-medium text-muted-foreground">{eyebrow}</p> : null}
        <h3 className="break-words text-base font-semibold leading-snug">{title}</h3>
      </div>
      {children ? <div className="mt-3 grid gap-3 text-sm">{children}</div> : null}
      {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
    </article>
  );
}

export function MobileDataField({
  children,
  className,
  label,
  valueClassName,
}: {
  children: ReactNode;
  className?: string;
  label: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div data-slot="admin-mobile-data-field" className={cn("min-w-0 space-y-1", className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className={cn("min-w-0 break-words", valueClassName)}>{children}</div>
    </div>
  );
}
