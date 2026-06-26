import nodemailer, { type Transporter } from "nodemailer";

import { ApiError } from "@/lib/api";
import { hmacSha256WithPurpose } from "@/lib/crypto";
import { formatDate } from "@/lib/dates";
import { logger } from "@/lib/logger";
import { getSmtpConfig, type ResolvedSmtpConfig } from "@/modules/config";
import { DEFAULT_LOCALE, type Locale, translate } from "@/modules/i18n";

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

async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const cfg = await getSmtpConfig();
  if (!cfg.configured) {
    throw new ApiError(500, "mailNotConfigured");
  }
  await getTransporter(cfg).sendMail({ from: cfg.from, to, subject, text });
  logger.info("邮件已发送", {
    recipientDigest: hmacSha256WithPurpose("mail-log-recipient", to.trim().toLowerCase()),
    subject,
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
  await sendMail(to, message.subject, message.text);
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
  await sendMail(to, message.subject, message.text);
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
  await sendMail(to, message.subject, message.text);
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
  await sendMail(to, message.subject, message.text);
}

export function renderPaymentRejectedEmail(
  tierName: string,
  reviewNote?: string | null,
  locale?: Locale,
) {
  const t = mailT(locale);
  return {
    subject: t("mail.rejectedSubject"),
    text: [
      t("mail.rejectedBody", { tier: tierName }),
      reviewNote ? `\n${t("mail.rejectedReason", { reason: reviewNote })}` : "",
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
  await sendMail(to, message.subject, message.text);
}

export function renderTestEmail(locale?: Locale) {
  const t = mailT(locale);
  return { subject: t("mail.testSubject"), text: t("mail.testBody") };
}

export async function sendTestEmail(to: string, locale?: Locale): Promise<void> {
  const message = renderTestEmail(locale);
  await sendMail(to, message.subject, message.text);
}
