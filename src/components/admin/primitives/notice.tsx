import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

type NoticeVariant = "info" | "success" | "warning" | "error";

const noticeClasses: Record<NoticeVariant, string> = {
  error: "border-destructive/30 bg-destructive/5 text-destructive",
  info: "border-border bg-muted/40 text-foreground",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200",
};

export function Notice({
  children,
  className,
  variant = "info",
}: {
  children: ReactNode;
  className?: string;
  variant?: NoticeVariant;
}) {
  const isError = variant === "error";
  return (
    <Alert
      aria-live={isError ? "assertive" : "polite"}
      className={cn(noticeClasses[variant], className)}
      role={isError ? "alert" : "status"}
      variant={isError ? "destructive" : "default"}
    >
      <AlertDescription
        className={cn(
          variant === "success" && "text-emerald-800 dark:text-emerald-200",
          variant === "warning" && "text-amber-900 dark:text-amber-200",
          isError && "text-destructive",
        )}
      >
        {children}
      </AlertDescription>
    </Alert>
  );
}
