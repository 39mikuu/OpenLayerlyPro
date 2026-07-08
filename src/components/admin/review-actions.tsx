"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import {
  PAYMENT_REJECT_REASON_CODES,
  type PaymentRejectReasonCode,
} from "@/modules/payment/rejection-note";

type ReviewDialog = "approve" | "reject";

type RejectReason = PaymentRejectReasonCode;

const REJECT_REASONS = PAYMENT_REJECT_REASON_CODES;

export type ReviewActionsContext = {
  amountLabel: string;
  note: string | null;
  proofHref: string | null;
  requestId: string;
  submittedAtLabel: string;
  tierName: string;
  userEmail: string;
};

export function ReviewActions({ context }: { context: ReviewActionsContext }) {
  const router = useRouter();
  const t = useT();
  const approveButtonRef = useRef<HTMLButtonElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLButtonElement | null>(null);
  const [dialog, setDialog] = useState<ReviewDialog | null>(null);
  const [pendingAction, setPendingAction] = useState<ReviewDialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<RejectReason>("proof_unclear");
  const [rejectDetails, setRejectDetails] = useState("");

  const loading = pendingAction !== null;

  function openDialog(nextDialog: ReviewDialog) {
    restoreFocusRef.current =
      nextDialog === "approve" ? approveButtonRef.current : rejectButtonRef.current;
    setError(null);
    setDialog(nextDialog);
  }

  function closeDialog() {
    if (loading) return;
    setDialog(null);
    window.setTimeout(() => restoreFocusRef.current?.focus(), 0);
  }

  function reasonLabel(reason: RejectReason): string {
    return t(`admin.reviews.rejectReason.${reason}`);
  }

  function focusAfterCompletion() {
    window.setTimeout(() => {
      const pendingHeading = document.getElementById("admin-payment-reviews-pending-heading");
      if (pendingHeading instanceof HTMLElement) {
        pendingHeading.focus();
        return;
      }
      restoreFocusRef.current?.focus();
    }, 50);
  }

  async function run(action: ReviewDialog, fn: () => Promise<void>) {
    setPendingAction(action);
    setError(null);
    try {
      await fn();
      setDialog(null);
      router.refresh();
      focusAfterCompletion();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          ref={approveButtonRef}
          size="sm"
          disabled={loading}
          onClick={() => openDialog("approve")}
        >
          {t("admin.reviews.approve")}
        </Button>
        <Button
          ref={rejectButtonRef}
          size="sm"
          variant="destructive"
          disabled={loading}
          onClick={() => openDialog("reject")}
        >
          {t("admin.reviews.reject")}
        </Button>
      </div>
      {error && !dialog ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          showCloseButton={!loading}
        >
          <DialogHeader>
            <DialogTitle>
              {dialog === "approve"
                ? t("admin.reviews.approveDialogTitle")
                : dialog === "reject"
                  ? t("admin.reviews.rejectDialogTitle")
                  : null}
            </DialogTitle>
            <DialogDescription>{t("admin.reviews.reviewDialogDescription")}</DialogDescription>
          </DialogHeader>

          <ReviewSummary context={context} t={t} />

          {dialog === "approve" ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              {t("admin.reviews.approveImpact")}
            </p>
          ) : null}

          {dialog === "reject" ? (
            <div className="space-y-3">
              <label className="space-y-2 text-sm font-medium">
                <span>{t("admin.reviews.rejectReasonLabel")}</span>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={rejectReason}
                  onChange={(event) => setRejectReason(event.target.value as RejectReason)}
                >
                  {REJECT_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {reasonLabel(reason)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-2 text-sm font-medium">
                <span>{t("admin.reviews.rejectDetailsLabel")}</span>
                <Textarea
                  maxLength={400}
                  rows={4}
                  value={rejectDetails}
                  onChange={(event) => setRejectDetails(event.target.value)}
                  placeholder={t("admin.reviews.rejectDetailsPlaceholder")}
                />
              </label>
            </div>
          ) : null}

          {error && dialog ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {dialog ? (
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" disabled={loading} />}>
                {t("admin.common.cancel")}
              </DialogClose>
              {dialog === "approve" ? (
                <Button
                  type="button"
                  disabled={loading}
                  onClick={() =>
                    void run("approve", () =>
                      api(`/api/admin/payment-requests/${context.requestId}/approve`, {
                        method: "POST",
                      }),
                    )
                  }
                >
                  {pendingAction === "approve"
                    ? t("admin.reviews.approving")
                    : t("admin.reviews.confirmApproveAction")}
                </Button>
              ) : null}
              {dialog === "reject" ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={loading}
                  onClick={() =>
                    void run("reject", () =>
                      api(`/api/admin/payment-requests/${context.requestId}/reject`, {
                        method: "POST",
                        body: {
                          rejectReasonCode: rejectReason,
                          rejectDetails: rejectDetails.trim() || null,
                        },
                      }),
                    )
                  }
                >
                  {pendingAction === "reject"
                    ? t("admin.reviews.rejecting")
                    : t("admin.reviews.confirmRejectAction")}
                </Button>
              ) : null}
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReviewSummary({
  context,
  t,
}: {
  context: ReviewActionsContext;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const rows = [
    [t("admin.reviews.fanEmail"), context.userEmail],
    [t("admin.reviews.tier"), context.tierName],
    [t("admin.reviews.price"), context.amountLabel],
    [t("admin.reviews.submittedAt"), context.submittedAtLabel],
  ] as const;

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <dl className="grid gap-2 sm:grid-cols-[8rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-1">
        <p className="text-muted-foreground">{t("admin.reviews.proof")}</p>
        {context.proofHref ? (
          <a className="text-primary underline" href={context.proofHref} target="_blank">
            {t("admin.reviews.viewProof")}
          </a>
        ) : (
          <p>{t("admin.common.none")}</p>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground">{t("admin.reviews.note")}</p>
        <p className="whitespace-pre-wrap break-words">{context.note || "—"}</p>
      </div>
    </div>
  );
}
