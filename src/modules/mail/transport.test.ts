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

import { sendLoginCodeEmail, sendTestEmail } from "./index";

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
});
