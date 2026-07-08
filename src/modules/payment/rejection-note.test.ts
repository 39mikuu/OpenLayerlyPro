import { describe, expect, it } from "vitest";

import { translate } from "@/modules/i18n";

import {
  formatPaymentRejectionReviewNote,
  parsePaymentRejectionReviewNote,
  paymentRejectionAuditReason,
  serializePaymentRejectionReviewNote,
} from "./rejection-note";

describe("payment rejection review notes", () => {
  it("stores a stable reason code and localizes canned reasons at render time", () => {
    const stored = serializePaymentRejectionReviewNote({
      rejectReasonCode: "proof_unclear",
      rejectDetails: "Please upload the transfer receipt.",
    });

    expect(stored).toContain("payment_rejection:v1:");
    expect(stored).toContain("proof_unclear");
    expect(stored).not.toContain("Payment proof is unclear");
    expect(stored).not.toContain("付款凭证不清晰");
    expect(stored).not.toContain("支払い証明");

    expect(
      formatPaymentRejectionReviewNote(stored, (key, params) => translate("en", key, params)),
    ).toBe("Payment proof is unclear or incomplete: Please upload the transfer receipt.");
    expect(
      formatPaymentRejectionReviewNote(stored, (key, params) => translate("zh", key, params)),
    ).toBe("付款凭证不清晰或信息不足: Please upload the transfer receipt.");
    expect(
      formatPaymentRejectionReviewNote(stored, (key, params) => translate("ja", key, params)),
    ).toBe("支払い証明が不鮮明または情報不足です: Please upload the transfer receipt.");
  });

  it("keeps legacy free-form review notes readable", () => {
    expect(parsePaymentRejectionReviewNote("proof is unclear")).toEqual({
      kind: "legacy",
      reviewNote: "proof is unclear",
    });
    expect(
      formatPaymentRejectionReviewNote("proof is unclear", (key, params) =>
        translate("en", key, params),
      ),
    ).toBe("proof is unclear");
  });

  it("uses stable codes rather than localized text for audit reasons", () => {
    expect(
      paymentRejectionAuditReason({
        rejectReasonCode: "wrong_amount",
        rejectDetails: "Expected $99.",
      }),
    ).toBe("wrong_amount: Expected $99.");
  });
});
