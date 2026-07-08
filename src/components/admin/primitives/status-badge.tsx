import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusTone = "danger" | "info" | "neutral" | "success" | "warning";

const toneClasses: Record<StatusTone, string> = {
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-200",
  neutral: "border-border bg-secondary text-secondary-foreground",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200",
};

export function StatusBadge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: StatusTone;
}) {
  return (
    <Badge className={cn(toneClasses[tone], className)} variant="outline">
      {children}
    </Badge>
  );
}
