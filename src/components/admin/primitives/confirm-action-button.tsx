"use client";

import type { ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import { Notice } from "@/components/admin/primitives/notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ButtonProps = React.ComponentProps<typeof Button>;

export function ConfirmActionButton({
  actionLabel,
  cancelLabel,
  className,
  closeLabel,
  confirmLabel,
  confirmVariant = "destructive",
  description,
  disabled,
  errorFallback,
  finalFocusFallbackRef,
  loadingLabel,
  onConfirm,
  onOpenChange,
  open: controlledOpen,
  size = "sm",
  title,
  triggerOpensDialog = true,
  triggerType = "button",
  variant = "outline",
}: {
  actionLabel: ReactNode;
  cancelLabel: ReactNode;
  className?: string;
  closeLabel: ReactNode;
  confirmLabel: ReactNode;
  confirmVariant?: ButtonProps["variant"];
  description: ReactNode;
  disabled?: boolean;
  errorFallback: string;
  finalFocusFallbackRef?: RefObject<HTMLElement | null>;
  loadingLabel?: ReactNode;
  onConfirm: () => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  size?: ButtonProps["size"];
  title: ReactNode;
  triggerOpensDialog?: boolean;
  triggerType?: "button" | "submit";
  variant?: ButtonProps["variant"];
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const open = controlledOpen ?? uncontrolledOpen;

  function setDialogOpen(nextOpen: boolean) {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function confirmAction() {
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
      setDialogOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : errorFallback);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (loading && !nextOpen) return;
        setDialogOpen(nextOpen);
        if (nextOpen) setError(null);
      }}
    >
      {triggerOpensDialog ? (
        <DialogTrigger
          render={
            <Button
              ref={actionButtonRef}
              className={className}
              disabled={disabled || loading}
              size={size}
              type={triggerType}
              variant={variant}
            />
          }
        >
          {loading && loadingLabel ? loadingLabel : actionLabel}
        </DialogTrigger>
      ) : (
        <Button
          ref={actionButtonRef}
          className={className}
          disabled={disabled || loading}
          size={size}
          type={triggerType}
          variant={variant}
        >
          {loading && loadingLabel ? loadingLabel : actionLabel}
        </Button>
      )}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        closeLabel={closeLabel}
        finalFocus={() => {
          const actionButton = actionButtonRef.current;
          if (actionButton && !actionButton.disabled) return actionButton;
          return finalFocusFallbackRef?.current ?? actionButton;
        }}
        showCloseButton={!loading}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && <Notice variant="error">{error}</Notice>}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={loading} />}>
            {cancelLabel}
          </DialogClose>
          <Button type="button" variant={confirmVariant} disabled={loading} onClick={confirmAction}>
            {loading && loadingLabel ? loadingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
