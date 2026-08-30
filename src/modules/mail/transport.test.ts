import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "mail-log-test-secret-that-is-long-enough",
  });
});

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  getSmtpConfig: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));
vi.mock("@/modules/config", () => ({
  getSmtpConfig: mocks.getSmtpConfig,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));

import {
  type MailTaskOwnershipOptions,
  sendLoginCodeEmail,
  sendMagicLinkEmail,
  sendMagicLinkEmailWithDeadline,
  sendMembershipActivatedEmail,
  sendMembershipRevokedEmail,
  sendNewPostNotificationEmail,
  sendPaymentRejectedEmail,
  sendRenewalReminderEmail,
  sendTestEmail,
} from "./index";

const durableTransactionalSenders: Array<
  [string, (options: MailTaskOwnershipOptions) => Promise<void>]
> = [
  [
    "login code",
    (options) => sendLoginCodeEmail("fan@example.com", "ABCD1234EFGH5678", "en", options),
  ],
  [
    "membership activation",
    (options) =>
      sendMembershipActivatedEmail(
        "fan@example.com",
        "Supporter",
        new Date("2026-08-20T00:00:00.000Z"),
        "en",
        options,
      ),
  ],
  [
    "membership revocation",
    (options) => sendMembershipRevokedEmail("fan@example.com", "Supporter", "en", options),
  ],
  [
    "payment rejection",
    (options) =>
      sendPaymentRejectedEmail("fan@example.com", "Supporter", "Proof unclear", "en", options),
  ],
  [
    "renewal reminder",
    (options) =>
      sendRenewalReminderEmail(
        "fan@example.com",
        "Supporter",
        new Date("2026-08-20T00:00:00.000Z"),
        "en",
        options,
      ),
  ],
];

describe("SMTP transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
    mocks.sendMail.mockResolvedValue(undefined);
    mocks.getSmtpConfig.mockResolvedValue({
      configured: true,
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "mailer",
      password: "secret",
      from: "noreply@example.com",
    });
  });

  it("sets bounded connection, greeting, and socket timeouts", async () => {
    await sendTestEmail("admin@example.com", "en");

    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 45_000,
      }),
    );
  });

  it("sends HTML and plain-text alternatives for the core transactional emails", async () => {
    await sendLoginCodeEmail("fan@example.com", "123456", "en");
    await sendMagicLinkEmail("fan@example.com", "https://example.test/login/magic/token", "en");
    await sendMembershipActivatedEmail(
      "fan@example.com",
      "Supporter",
      new Date("2026-08-20T00:00:00.000Z"),
      "en",
    );

    expect(mocks.sendMail).toHaveBeenCalledTimes(3);
    for (const [message] of mocks.sendMail.mock.calls) {
      expect(message.text).toEqual(expect.any(String));
      expect(message.html).toMatch(/^<!doctype html>/);
      expect(message.html).toContain("Artist Member Site");
    }
    expect(mocks.sendMail.mock.calls[0]?.[0]?.html).toContain("123456");
    expect(mocks.sendMail.mock.calls[1]?.[0]?.html).toContain(
      'href="https://example.test/login/magic/token"',
    );
    expect(mocks.sendMail.mock.calls[2]?.[0]?.html).toContain('href="http://localhost:3000/me"');
  });

  it("keeps HTML on the deadline-bounded Magic Link transport", async () => {
    const close = vi.fn();
    mocks.createTransport.mockReturnValueOnce({ sendMail: mocks.sendMail, close });

    await sendMagicLinkEmailWithDeadline(
      "fan@example.com",
      "https://example.test/login/magic/token",
      "en",
      5,
    );

    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("https://example.test/login/magic/token"),
        html: expect.stringContaining('href="https://example.test/login/magic/token"'),
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("revalidates Magic Link task ownership after config resolution and before SMTP", async () => {
    let finishConfigResolution!: (config: Awaited<ReturnType<typeof mocks.getSmtpConfig>>) => void;
    const configBlocked = new Promise<Awaited<ReturnType<typeof mocks.getSmtpConfig>>>(
      (resolve) => {
        finishConfigResolution = resolve;
      },
    );
    mocks.getSmtpConfig.mockReturnValueOnce(configBlocked);
    const ownershipLost = new Error("task ownership lost");
    const assertTaskOwnership = vi.fn().mockRejectedValue(ownershipLost);

    const delivery = sendMagicLinkEmail(
      "fan@example.com",
      "https://example.test/login/magic/token",
      "en",
      { assertTaskOwnership },
    );
    await vi.waitFor(() => expect(mocks.getSmtpConfig).toHaveBeenCalledOnce());
    expect(assertTaskOwnership).not.toHaveBeenCalled();

    finishConfigResolution({
      configured: true,
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "mailer",
      password: "secret",
      from: "noreply@example.com",
    });
    await expect(delivery).rejects.toBe(ownershipLost);
    expect(assertTaskOwnership).toHaveBeenCalledOnce();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it.each(durableTransactionalSenders)(
    "revalidates %s task ownership after config resolution and before SMTP",
    async (_label, startDelivery) => {
      let finishConfigResolution!: (
        config: Awaited<ReturnType<typeof mocks.getSmtpConfig>>,
      ) => void;
      const configBlocked = new Promise<Awaited<ReturnType<typeof mocks.getSmtpConfig>>>(
        (resolve) => {
          finishConfigResolution = resolve;
        },
      );
      mocks.getSmtpConfig.mockReturnValueOnce(configBlocked);
      const ownershipLost = new Error("task ownership lost");
      const assertTaskOwnership = vi.fn().mockRejectedValue(ownershipLost);

      const delivery = startDelivery({ assertTaskOwnership });
      await vi.waitFor(() => expect(mocks.getSmtpConfig).toHaveBeenCalledOnce());
      expect(assertTaskOwnership).not.toHaveBeenCalled();

      finishConfigResolution({
        configured: true,
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "mailer",
        password: "secret",
        from: "noreply@example.com",
      });
      await expect(delivery).rejects.toBe(ownershipLost);
      expect(assertTaskOwnership).toHaveBeenCalledOnce();
      expect(mocks.sendMail).not.toHaveBeenCalled();
    },
  );

  it("revalidates notification task ownership after config resolution and before SMTP", async () => {
    let finishConfigResolution!: (config: Awaited<ReturnType<typeof mocks.getSmtpConfig>>) => void;
    const configBlocked = new Promise<Awaited<ReturnType<typeof mocks.getSmtpConfig>>>(
      (resolve) => {
        finishConfigResolution = resolve;
      },
    );
    mocks.getSmtpConfig.mockReturnValueOnce(configBlocked);
    const ownershipLost = new Error("task ownership lost");
    const assertTaskOwnership = vi.fn().mockRejectedValue(ownershipLost);

    const delivery = sendNewPostNotificationEmail(
      "fan@example.com",
      {
        title: "Restricted launch notes",
        summary: "Private summary",
        postUrl: "https://example.test/posts/restricted",
        unsubscribeConfirmUrl: "https://example.test/unsubscribe/notifications/token",
        unsubscribeOneClickUrl: "https://example.test/api/notifications/unsubscribe/token",
        siteName: "Example Site",
      },
      "en",
      {},
      { template: "new_post_notification", category: "notification" },
      { assertTaskOwnership },
    );
    await vi.waitFor(() => expect(mocks.getSmtpConfig).toHaveBeenCalledOnce());
    expect(assertTaskOwnership).not.toHaveBeenCalled();

    finishConfigResolution({
      configured: true,
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "mailer",
      password: "secret",
      from: "noreply@example.com",
    });
    await expect(delivery).rejects.toBe(ownershipLost);
    expect(assertTaskOwnership).toHaveBeenCalledOnce();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("classifies the raw provider error before discarding sensitive transport details", async () => {
    mocks.sendMail.mockRejectedValue({
      code: "EAUTH",
      responseCode: 535,
      response: "credentials rejected for fan@example.com; body=private",
    });

    const error = await sendTestEmail("fan@example.com", "en").catch((caught) => caught);
    expect(error).toMatchObject({
      name: "MailDeliveryError",
      message: "SMTP delivery failed",
      kind: "needs_operator",
    });
    expect(JSON.stringify(error)).not.toContain("fan@example.com");
    expect(JSON.stringify(error)).not.toContain("body=private");
  });

  it("logs stable recipient digests without raw recipients or login codes", async () => {
    const rawRecipient = "fan@example.com";
    const otherRecipient = "other@example.com";
    const loginCode = "ABCD1234EFGH5678";

    await sendTestEmail(" Fan@Example.com ", "en");
    await sendTestEmail(rawRecipient, "en");
    await sendLoginCodeEmail(otherRecipient, loginCode, "en");

    const firstDigest = mocks.loggerInfo.mock.calls[0]?.[1]?.recipientDigest as string;
    const secondDigest = mocks.loggerInfo.mock.calls[1]?.[1]?.recipientDigest as string;
    const otherDigest = mocks.loggerInfo.mock.calls[2]?.[1]?.recipientDigest as string;
    expect(firstDigest).toBe(secondDigest);
    expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(firstDigest).not.toBe(rawRecipient);
    expect(otherDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(otherDigest).not.toBe(firstDigest);

    const fullLoggerArguments = JSON.stringify(mocks.loggerInfo.mock.calls);
    expect(fullLoggerArguments).not.toContain(rawRecipient);
    expect(fullLoggerArguments).not.toContain(otherRecipient);
    expect(fullLoggerArguments).not.toContain(loginCode);
  });

  it("adds mandatory unsubscribe headers and logs only safe notification metadata", async () => {
    await sendNewPostNotificationEmail(
      "fan@example.com",
      {
        title: "Restricted launch notes",
        summary: "Private summary",
        postUrl: "https://example.test/posts/restricted",
        unsubscribeConfirmUrl: "https://example.test/unsubscribe/notifications/token",
        unsubscribeOneClickUrl: "https://example.test/api/notifications/unsubscribe/token",
        siteName: "Example Site",
      },
      "en",
      { "X-Test": "kept" },
      {
        template: "new_post_notification",
        category: "notification",
        campaignId: "campaign-1",
        deliveryId: "delivery-1",
        attemptId: "attempt-1",
        recipientDigest: "a".repeat(64),
      },
    );

    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "fan@example.com",
        subject: "New post: Restricted launch notes",
        headers: {
          "X-Test": "kept",
          "List-Unsubscribe": "<https://example.test/api/notifications/unsubscribe/token>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    );

    const logArguments = JSON.stringify(mocks.loggerInfo.mock.calls);
    expect(logArguments).toContain("campaign-1");
    expect(logArguments).toContain("delivery-1");
    expect(logArguments).toContain("attempt-1");
    expect(logArguments).toContain("a".repeat(64));
    expect(logArguments).not.toContain("fan@example.com");
    expect(logArguments).not.toContain("Restricted launch notes");
    expect(logArguments).not.toContain("Private summary");
  });
});
