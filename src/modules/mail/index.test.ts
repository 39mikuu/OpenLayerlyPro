import { describe, expect, it } from "vitest";

import { serializePaymentRejectionReviewNote } from "@/modules/payment/rejection-note";

import {
  renderLoginCodeEmail,
  renderMagicLinkEmail,
  renderMembershipActivatedEmail,
  renderMembershipRevokedEmail,
  renderPaymentRejectedEmail,
  renderTestEmail,
} from "./index";

describe("localized mail templates", () => {
  it("renders login codes in the requested locale and defaults to Chinese", () => {
    expect(renderLoginCodeEmail("123456", "en")).toEqual({
      subject: "Your sign-in code",
      text: [
        "Your verification code is: 123456",
        "",
        "The code is valid for 10 minutes.",
        "If you did not request this, you can ignore this email.",
      ].join("\n"),
    });
    expect(renderLoginCodeEmail("123456").subject).toBe("你的登录验证码");
  });

  it("renders magic link emails with the confirm URL and localized framing", () => {
    const url = "https://site.example/login/magic/olp_mlk.v1.current.abc";
    const en = renderMagicLinkEmail(url, "en");
    expect(en.subject).toBe("Your login link");
    expect(en.text).toContain(url);
    expect(en.text).toContain("15 minutes");

    const zh = renderMagicLinkEmail(url);
    expect(zh.subject).toBe("你的登录链接");
    expect(zh.text).toContain(url);

    const ja = renderMagicLinkEmail(url, "ja");
    expect(ja.subject).toBe("ログインリンク");
    expect(ja.text).toContain(url);
  });

  it("renders membership and rejection data without translating user content", () => {
    const membership = renderMembershipActivatedEmail("黄金会员", new Date(2026, 5, 30), "en");
    expect(membership.subject).toBe("Membership activated");
    expect(membership.text).toContain("Membership tier: 黄金会员");
    expect(membership.text).toContain("Valid until: 2026-06-30");

    const revoked = renderMembershipRevokedEmail("Gold", "en");
    expect(revoked.subject).toBe("Membership access disabled");
    expect(revoked.text).toContain("Membership tier: Gold");
    expect(revoked.text).not.toContain("Stripe");

    const rejected = renderPaymentRejectedEmail("Gold", "截图不清晰", "en");
    expect(rejected.subject).toBe("Payment request rejected");
    expect(rejected.text).toContain("Reason: 截图不清晰");
  });

  it("localizes structured payment rejection reasons for the recipient locale", () => {
    const stored = serializePaymentRejectionReviewNote({
      rejectReasonCode: "wrong_account",
      rejectDetails: "Use the creator account shown on checkout.",
    });

    const english = renderPaymentRejectedEmail("Gold", stored, "en");
    expect(english.text).toContain(
      "Reason: Payment account or method does not match: Use the creator account shown on checkout.",
    );
    expect(english.text).not.toContain("wrong_account");

    const japanese = renderPaymentRejectedEmail("ゴールド", stored, "ja");
    expect(japanese.text).toContain(
      "理由：支払いアカウントまたは方法が一致しません: Use the creator account shown on checkout.",
    );
    expect(japanese.text).not.toContain("Payment account or method does not match");
  });

  it("renders test email in the administrator request locale", () => {
    expect(renderTestEmail("en")).toEqual({
      subject: "Test email",
      text: "This test email confirms that the site SMTP configuration works.",
    });
  });

  it("renders Japanese transactional emails", () => {
    expect(renderLoginCodeEmail("123456", "ja")).toEqual({
      subject: "ログイン認証コード",
      text: [
        "認証コード：123456",
        "",
        "認証コードは10分間有効です。",
        "この操作に心当たりがない場合は、このメールを無視してください。",
      ].join("\n"),
    });

    expect(renderMembershipActivatedEmail("ゴールド", new Date(2026, 5, 30), "ja").text).toContain(
      "メンバーシッププラン：ゴールド",
    );
    expect(renderMembershipRevokedEmail("ゴールド", "ja").subject).toBe(
      "メンバーシップの利用を停止しました",
    );
    expect(renderPaymentRejectedEmail("ゴールド", "画像が不鮮明です", "ja").text).toContain(
      "理由：画像が不鮮明です",
    );
    expect(renderTestEmail("ja").subject).toBe("テストメール");
  });
});
