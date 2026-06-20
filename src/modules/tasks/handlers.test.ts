import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupOrphanFile: vi.fn(),
  deleteStorageObject: vi.fn(),
  getSmtpConfig: vi.fn(),
  sendMembershipActivatedEmail: vi.fn(),
  sendMembershipRevokedEmail: vi.fn(),
  sendPaymentRejectedEmail: vi.fn(),
}));

vi.mock("@/modules/config", () => ({ getSmtpConfig: mocks.getSmtpConfig }));
vi.mock("@/modules/file/cleanup", () => ({
  cleanupOrphanFile: mocks.cleanupOrphanFile,
  deleteStorageObject: mocks.deleteStorageObject,
  UnsupportedOrphanCleanupPurposeError: class UnsupportedOrphanCleanupPurposeError extends Error {},
}));
vi.mock("@/modules/mail", () => ({
  sendMembershipActivatedEmail: mocks.sendMembershipActivatedEmail,
  sendMembershipRevokedEmail: mocks.sendMembershipRevokedEmail,
  sendPaymentRejectedEmail: mocks.sendPaymentRejectedEmail,
}));

import type { Task } from "@/db/schema";

import { runTaskHandler } from "./handlers";

function task(payloadJson: Record<string, unknown>, kind = "email"): Task {
  const now = new Date();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind,
    dedupeKey: null,
    payloadJson,
    runAfter: now,
    status: "processing",
    attempts: 1,
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
    mocks.cleanupOrphanFile.mockResolvedValue("deleted");
    mocks.deleteStorageObject.mockResolvedValue(undefined);
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

  it("dispatches membership revocation notifications without provider details", async () => {
    await runTaskHandler(
      task({
        template: "membership_revoked",
        to: "fan@example.com",
        locale: "zh",
        params: { tierName: "Supporter" },
      }),
    );

    expect(mocks.sendMembershipRevokedEmail).toHaveBeenCalledWith(
      "fan@example.com",
      "Supporter",
      "zh",
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

  it("runs first-stage orphan cleanup from an immutable file id payload", async () => {
    const fileId = "550e8400-e29b-41d4-a716-446655440000";
    const result = await runTaskHandler(task({ fileId }, "file.cleanup_orphan"));

    expect(mocks.cleanupOrphanFile).toHaveBeenCalledWith(fileId);
    expect(result.note).toContain("deleted");
  });

  it("runs second-stage storage deletion only from the task payload", async () => {
    const payload = {
      storageDriver: "local",
      bucket: null,
      objectKey: "content/2026/06/image.png",
    } as const;
    await runTaskHandler(task(payload, "storage.delete_object"));
    expect(mocks.deleteStorageObject).toHaveBeenCalledWith(payload);
  });

  it("propagates temporary storage failures so the dispatcher can retry", async () => {
    mocks.deleteStorageObject.mockRejectedValue(new Error("temporary storage outage"));
    await expect(
      runTaskHandler(
        task(
          { storageDriver: "s3", bucket: "private", objectKey: "content/image.png" },
          "storage.delete_object",
        ),
      ),
    ).rejects.toThrow("temporary storage outage");
  });
});
