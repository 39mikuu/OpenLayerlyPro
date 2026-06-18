import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmtpConfig: vi.fn(),
  sendMembershipActivatedEmail: vi.fn(),
  sendPaymentRejectedEmail: vi.fn(),
}));

vi.mock("@/modules/config", () => ({ getSmtpConfig: mocks.getSmtpConfig }));
vi.mock("@/modules/mail", () => ({
  sendMembershipActivatedEmail: mocks.sendMembershipActivatedEmail,
  sendPaymentRejectedEmail: mocks.sendPaymentRejectedEmail,
}));

import type { Task } from "@/db/schema";

import { runTaskHandler } from "./handlers";

function task(payloadJson: Record<string, unknown>): Task {
  const now = new Date();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "email",
    dedupeKey: null,
    payloadJson,
    runAfter: now,
    status: "processing",
    attempts: 0,
    maxAttempts: 5,
    lockedAt: now,
    lockedBy: "worker",
    leaseUntil: new Date(now.getTime() + 60_000),
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("task handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSmtpConfig.mockResolvedValue({ configured: true });
  });

  it("treats missing SMTP configuration as a successful no-op", async () => {
    mocks.getSmtpConfig.mockResolvedValue({ configured: false });

    const result = await runTaskHandler(
      task({
        template: "payment_rejected",
        to: "fan@example.com",
        locale: "ja",
        params: { tierName: "Supporter", reviewNote: null },
      }),
    );

    expect(result.note).toContain("SMTP not configured");
    expect(mocks.sendPaymentRejectedEmail).not.toHaveBeenCalled();
  });

  it("renders membership activation parameters at dispatch time", async () => {
    await runTaskHandler(
      task({
        template: "membership_activated",
        to: "fan@example.com",
        locale: "ja",
        params: {
          tierName: "Supporter",
          endsAt: "2026-07-18T10:00:00.000Z",
        },
      }),
    );

    expect(mocks.sendMembershipActivatedEmail).toHaveBeenCalledWith(
      "fan@example.com",
      "Supporter",
      new Date("2026-07-18T10:00:00.000Z"),
      "ja",
    );
  });

  it("sends rejection parameters without exposing arbitrary payload shapes", async () => {
    await runTaskHandler(
      task({
        template: "payment_rejected",
        to: "fan@example.com",
        locale: "en",
        params: { tierName: "Supporter", reviewNote: "Proof unclear" },
      }),
    );

    expect(mocks.sendPaymentRejectedEmail).toHaveBeenCalledWith(
      "fan@example.com",
      "Supporter",
      "Proof unclear",
      "en",
    );
  });
});
