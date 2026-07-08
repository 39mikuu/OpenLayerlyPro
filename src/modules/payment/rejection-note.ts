import type { Translate } from "@/modules/i18n";

export const PAYMENT_REJECT_REASON_CODES = [
  "proof_unclear",
  "wrong_amount",
  "wrong_account",
  "duplicate",
  "other",
] as const;

export type PaymentRejectReasonCode = (typeof PAYMENT_REJECT_REASON_CODES)[number];

export type StructuredPaymentRejection = {
  rejectReasonCode: PaymentRejectReasonCode;
  rejectDetails?: string | null;
};

const STRUCTURED_REVIEW_NOTE_PREFIX = "payment_rejection:v1:";

type ParsedPaymentRejectionNote =
  | { kind: "structured"; rejectReasonCode: PaymentRejectReasonCode; rejectDetails: string | null }
  | { kind: "legacy"; reviewNote: string | null };

function isPaymentRejectReasonCode(value: unknown): value is PaymentRejectReasonCode {
  return (
    typeof value === "string" && (PAYMENT_REJECT_REASON_CODES as readonly string[]).includes(value)
  );
}

function cleanDetails(details: string | null | undefined): string | null {
  const trimmed = details?.trim();
  return trimmed ? trimmed : null;
}

export function serializePaymentRejectionReviewNote({
  rejectReasonCode,
  rejectDetails,
}: StructuredPaymentRejection): string {
  return `${STRUCTURED_REVIEW_NOTE_PREFIX}${JSON.stringify({
    rejectReasonCode,
    rejectDetails: cleanDetails(rejectDetails),
  })}`;
}

export function parsePaymentRejectionReviewNote(
  reviewNote: string | null | undefined,
): ParsedPaymentRejectionNote {
  if (!reviewNote) return { kind: "legacy", reviewNote: null };
  if (!reviewNote.startsWith(STRUCTURED_REVIEW_NOTE_PREFIX)) {
    return { kind: "legacy", reviewNote };
  }

  try {
    const parsed = JSON.parse(reviewNote.slice(STRUCTURED_REVIEW_NOTE_PREFIX.length)) as {
      rejectReasonCode?: unknown;
      rejectDetails?: unknown;
    };
    if (!isPaymentRejectReasonCode(parsed.rejectReasonCode)) {
      return { kind: "legacy", reviewNote };
    }
    return {
      kind: "structured",
      rejectReasonCode: parsed.rejectReasonCode,
      rejectDetails:
        typeof parsed.rejectDetails === "string" ? cleanDetails(parsed.rejectDetails) : null,
    };
  } catch {
    return { kind: "legacy", reviewNote };
  }
}

export function paymentRejectReasonLabel(
  rejectReasonCode: PaymentRejectReasonCode,
  t: Translate,
): string {
  return t(`admin.reviews.rejectReason.${rejectReasonCode}`);
}

export function formatPaymentRejectionReviewNote(
  reviewNote: string | null | undefined,
  t: Translate,
): string | null {
  const parsed = parsePaymentRejectionReviewNote(reviewNote);
  if (parsed.kind === "legacy") return parsed.reviewNote;

  const reason = paymentRejectReasonLabel(parsed.rejectReasonCode, t);
  return parsed.rejectDetails ? `${reason}: ${parsed.rejectDetails}` : reason;
}

export function paymentRejectionAuditReason(
  input: StructuredPaymentRejection | { reviewNote?: string | null },
): string | null {
  if ("rejectReasonCode" in input) {
    const details = cleanDetails(input.rejectDetails);
    return details ? `${input.rejectReasonCode}: ${details}` : input.rejectReasonCode;
  }
  return input.reviewNote?.trim() || null;
}
