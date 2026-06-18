import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  getSmtpConfig: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));
vi.mock("@/modules/config", () => ({
  getSmtpConfig: mocks.getSmtpConfig,
}));

import { sendTestEmail } from "./index";

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
});
