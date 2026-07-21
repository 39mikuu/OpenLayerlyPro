import nodemailer, { type Transporter } from "nodemailer";

import { ApiError } from "@/lib/api";
import { hmacSha256WithPurpose } from "@/lib/crypto";
import { formatDate } from "@/lib/dates";
import { logger } from "@/lib/logger";
import { getSmtpConfig, type ResolvedSmtpConfig } from "@/modules/config";
import { DEFAULT_LOCALE, type Locale, translate } from "@/modules/i18n";
import { formatPaymentRejectionReviewNote } from "@/modules/payment/rejection-note";

import { classifyMailError, MailDeliveryError } from "./delivery";

export type MailSafeLog = {
  template: string;
  category: "transactional" | "notification" | "test";
  campaignId?: string;
  deliveryId?: string;
  attemptId?: string;
  recipientDigest?: string;
};

type SendMailInput = {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  safeLog?: MailSafeLog;
};

// 按解析后配置缓存 transporter;配置变更(后台保存)后缓存键变化会自动重建,
// 避免沿用旧连接配置。
let cached: { key: string; transporter: Transporter } | null = null;

function getTransporter(cfg: ResolvedSmtpConfig): Transporter {
  const key = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.password]);
  if (cached && cached.key === key) return cached.transporter;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
  });
  cached = { key, transporter };
  return transporter;
}

async function sendMail(input: SendMailInput): Promise<void> {
  const cfg = await getSmtpConfig();
  if (!cfg.configured) {
    throw new ApiError(500, "mailNotConfigured");
  }
  try {
    await getTransporter(cfg).sendMail({
      from: cfg.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      headers: input.headers,
    });
  } catch (error) {
    // Classify while the structured Nodemailer error is still available, then
    // discard the original object because it may include recipients, response
    // text, envelope data, or the rendered body (including login codes).
    throw new MailDeliveryError(classifyMailError(error));
  }
  if (input.safeLog?.category === "notification") {
    logger.info("notification email accepted by smtp", {
      template: input.safeLog.template,
      category: input.safeLog.category,
      campaignId: input.safeLog.campaignId,
      deliveryId: input.safeLog.deliveryId,
      attemptId: input.safeLog.attemptId,
      recipientDigest: input.safeLog.recipientDigest,
      outcome: "accepted",
    });
    return;
  }

  logger.info("邮件已发送", {
    template: input.safeLog?.template,
    category: input.safeLog?.category ?? "transactional",
    recipientDigest:
      input.safeLog?.recipientDigest ??
      hmacSha256WithPurpose("mail-log-recipient", input.to.trim().toLowerCase()),
  });
}

function mailT(locale: Locale | undefined) {
  return (key: string, params?: Record<string, string | number>) =>
    translate(locale ?? DEFAULT_LOCALE, key, params);
}

export function renderLoginCodeEmail(code: string, locale?: Locale) {
  const t = mailT(locale);
  return {
    subject: t("mail.loginSubject"),
    text: [t("mail.loginCode", { code }), "", t("mail.loginExpiry"), t("mail.ignore")].join("\n"),
  };
}

export async function sendLoginCodeEmail(to: string, code: string, locale?: Locale): Promise<void> {
  const message = renderLoginCodeEmail(code, locale);
  await sendMail({ to, subject: message.subject, text: message.text });
}

export function renderMagicLinkEmail(confirmUrl: string, locale?: Locale) {
  const t = mailT(locale);
  return {
    subject: t("mail.magicLinkSubject"),
    text: [
      t("mail.magicLinkIntro"),
      "",
      confirmUrl,
      "",
      t("mail.magicLinkExpiry"),
      t("mail.magicLinkConfirmNote"),
      t("mail.ignore"),
    ].join("\n"),
  };
}

export async function sendMagicLinkEmail(
  to: string,
  confirmUrl: string,
  locale?: Locale,
): Promise<void> {
  const message = renderMagicLinkEmail(confirmUrl, locale);
  await sendMail({ to, subject: message.subject, text: message.text });
}

export function renderMembershipActivatedEmail(tierName: string, endsAt: Date, locale?: Locale) {
  const t = mailT(locale);
  return {
    subject: t("mail.membershipSubject"),
    text: [
      t("mail.membershipOpened"),
      "",
      t("mail.membershipTier", { tier: tierName }),
      t("mail.membershipUntil", { date: formatDate(endsAt) }),
      "",
      t("mail.membershipReady"),
    ].join("\n"),
  };
}

export async function sendMembershipActivatedEmail(
  to: string,
  tierName: string,
  endsAt: Date,
  locale?: Locale,
): Promise<void> {
  const message = renderMembershipActivatedEmail(tierName, endsAt, locale);
  await sendMail({ to, subject: message.subject, text: message.text });
}

export function renderMembershipRevokedEmail(tierName: string, locale?: Locale) {
  const t = mailT(locale);
  return {
    subject: t("mail.membershipRevokedSubject"),
    text: [
      t("mail.membershipRevokedBody"),
      "",
      t("mail.membershipTier", { tier: tierName }),
      "",
      t("mail.membershipRevokedHelp"),
    ].join("\n"),
  };
}

export async function sendMembershipRevokedEmail(
  to: string,
  tierName: string,
  locale?: Locale,
): Promise<void> {
  const message = renderMembershipRevokedEmail(tierName, locale);
  await sendMail({ to, subject: message.subject, text: message.text });
}

export function renderRenewalReminderEmail(tierName: string, endsAt: Date, locale?: Locale) {
  const t = mailT(locale);
  return {
    subject: t("mail.renewalReminderSubject"),
    text: [
      t("mail.renewalReminderBody"),
      "",
      t("mail.membershipTier", { tier: tierName }),
      t("mail.membershipUntil", { date: formatDate(endsAt) }),
      "",
      t("mail.renewalReminderAction"),
    ].join("\n"),
  };
}

export async function sendRenewalReminderEmail(
  to: string,
  tierName: string,
  endsAt: Date,
  locale?: Locale,
): Promise<void> {
  const message = renderRenewalReminderEmail(tierName, endsAt, locale);
  await sendMail({ to, subject: message.subject, text: message.text });
}

export function renderPaymentRejectedEmail(
  tierName: string,
  reviewNote?: string | null,
  locale?: Locale,
) {
  const t = mailT(locale);
  const localizedReviewNote = formatPaymentRejectionReviewNote(reviewNote, t);
  return {
    subject: t("mail.rejectedSubject"),
    text: [
      t("mail.rejectedBody", { tier: tierName }),
      localizedReviewNote ? `\n${t("mail.rejectedReason", { reason: localizedReviewNote })}` : "",
      "",
      t("mail.rejectedRetry"),
    ].join("\n"),
  };
}

export async function sendPaymentRejectedEmail(
  to: string,
  tierName: string,
  reviewNote?: string | null,
  locale?: Locale,
): Promise<void> {
  const message = renderPaymentRejectedEmail(tierName, reviewNote, locale);
  await sendMail({ to, subject: message.subject, text: message.text });
}

export function renderTestEmail(locale?: Locale) {
  const t = mailT(locale);
  return { subject: t("mail.testSubject"), text: t("mail.testBody") };
}

export async function sendTestEmail(to: string, locale?: Locale): Promise<void> {
  const message = renderTestEmail(locale);
  await sendMail({
    to,
    subject: message.subject,
    text: message.text,
    safeLog: { template: "test", category: "test" },
  });
}

export function renderNewPostNotificationEmail(
  input: {
    title: string;
    summary: string | null;
    postUrl: string;
    unsubscribeConfirmUrl: string;
    siteName: string;
  },
  locale?: Locale,
) {
  const t = mailT(locale);
  return {
    subject: t("mail.newPostSubject", { title: input.title }),
    text: [
      input.siteName,
      "",
      t("mail.newPostIntro"),
      t("mail.newPostTitle", { title: input.title }),
      input.summary ? t("mail.newPostSummary", { summary: input.summary }) : "",
      "",
      t("mail.newPostOpen", { url: input.postUrl }),
      "",
      t("mail.newPostUnsubscribe", { url: input.unsubscribeConfirmUrl }),
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  };
}

export async function sendNewPostNotificationEmail(
  to: string,
  input: {
    title: string;
    summary: string | null;
    postUrl: string;
    unsubscribeConfirmUrl: string;
    unsubscribeOneClickUrl: string;
    siteName: string;
  },
  locale: Locale,
  headers: Record<string, string>,
  safeLog: MailSafeLog,
): Promise<void> {
  const message = renderNewPostNotificationEmail(
    {
      title: input.title,
      summary: input.summary,
      postUrl: input.postUrl,
      unsubscribeConfirmUrl: input.unsubscribeConfirmUrl,
      siteName: input.siteName,
    },
    locale,
  );
  await sendMail({
    to,
    subject: message.subject,
    text: message.text,
    headers: {
      ...headers,
      // RFC 8058: the header carries the one-click POST endpoint; the human
      // confirmation page link lives in the message body instead.
      "List-Unsubscribe": `<${input.unsubscribeOneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    safeLog: { ...safeLog, template: "new_post_notification", category: "notification" },
  });
}
