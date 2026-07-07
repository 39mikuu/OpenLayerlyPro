import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";

export function LoadingButton({
  children,
  disabled,
  loading,
  loadingText,
  ...props
}: ComponentProps<typeof Button> & {
  loading?: boolean;
  loadingText?: ReactNode;
}) {
  return (
    <Button aria-busy={loading || undefined} disabled={disabled || loading} {...props}>
      {loading ? (loadingText ?? children) : children}
    </Button>
  );
}
