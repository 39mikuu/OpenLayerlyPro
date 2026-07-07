import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "task-handler-test-session-secret-long-enough",
  });
});

const mocks = vi.hoisted(() => ({
  cleanupOrphanFile: vi.fn(),
  deleteStorageObject: vi.fn(),
  sendMembershipActivatedEmail: vi.fn(),
  sendMembershipRevokedEmail: vi.fn(),
  sendPaymentRejectedEmail: vi.fn(),
  sendRenewalReminderEmail: vi.fn(),
  dispatchPaymentProviderEvent: vi.fn(),
  deliverLoginCodeEmailTask: vi.fn(),
  reconcileSubscriptions: vi.fn(),
  nextSubscriptionReconcileAt: vi.fn(),
}));

vi.mock("@/modules/auth/login-code", () => ({
  deliverLoginCodeEmailTask: mocks.deliverLoginCodeEmailTask,
}));
vi.mock("@/modules/file/cleanup", () => ({
  cleanupOrphanFile: mocks.cleanupOrphanFile,
  deleteStorageObject: mocks.deleteStorageObject,
  UnsupportedOrphanCleanupPurposeError: class UnsupportedOrphanCleanupPurposeError extends Error {},
}));
vi.mock("@/modules/mail", () => ({
  sendMembershipActivatedEmail: mocks.sendMembershipActivatedEmail,
  sendMembershipRevokedEmail: mocks.sendMembershipRevokedEmail,
  sendPaymentRejectedEmail: mocks.sendPaymentRejectedEmail,
  sendRenewalReminderEmail: mocks.sendRenewalReminderEmail,
}));
vi.mock("@/modules/payment/subscriptions", () => ({
  dispatchPaymentProviderEvent: mocks.dispatchPaymentProviderEvent,
  reconcileSubscriptions: mocks.reconcileSubscriptions,
  nextSubscriptionReconcileAt: mocks.nextSubscriptionReconcileAt,
}));

import type { Task } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { MailDeliveryError } from "@/modules/mail/delivery";

import { PermanentTaskError } from "./errors";
import { runTaskHandler } from "./handlers";

function task(payloadJson: Record<string, unknown>, kind = "email", createdAt = new Date()): Task {
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
    createdAt,
    updatedAt: now,
  };
}

describe("task handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMembershipActivatedEmail.mockResolvedValue(undefined);
    mocks.sendMembershipRevokedEmail.mockResolvedValue(undefined);
    mocks.sendPaymentRejectedEmail.mockResolvedValue(undefined);
    mocks.sendRenewalReminderEmail.mockResolvedValue(undefined);
    mocks.cleanupOrphanFile.mockResolvedValue("deleted");
    mocks.deleteStorageObject.mockResolvedValue(undefined);
    mocks.dispatchPaymentProviderEvent.mockResolvedValue(undefined);
    mocks.deliverLoginCodeEmailTask.mockResolvedValue(undefined);
    mocks.reconcileSubscriptions.mockResolvedValue(0);
    mocks.nextSubscriptionReconcileAt.mockReturnValue(new Date("2026-06-25T08:00:00.000Z"));
  });

  it("defers missing SMTP configuration without marking the task succeeded", async () => {
    mocks.sendPaymentRejectedEmail.mockRejectedValue(new ApiError(500, "mailNotConfigured"));
    const before = Date.now();

    const result = await runTaskHandler(
      task({
        template: "payment_rejected",
        to: "fan@example.com",
        locale: "ja",
        params: { tierName: "Supporter", reviewNote: null },
      }),
    );

    expect(result.note).toContain("delivery deferred");
    expect(result.deferUntil?.getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1_000);
    expect(mocks.sendPaymentRejectedEmail).toHaveBeenCalledOnce();
  });

  it("dead-letters an operator-blocked business email after the maximum age", async () => {
    mocks.sendPaymentRejectedEmail.mockRejectedValue(new ApiError(500, "mailNotConfigured"));
    const oldTask = task(
      {
        template: "payment_rejected",
        to: "fan@example.com",
        locale: "en",
        params: { tierName: "Supporter", reviewNote: null },
      },
      "email",
      new Date(Date.now() - 25 * 60 * 60 * 1_000),
    );

    await expect(runTaskHandler(oldTask)).rejects.toMatchObject({
      message: "SMTP unavailable; email expired after 24 h",
      classification: "needs_operator",
    });
  });

  it("turns permanent SMTP failures into an immediate permanent task error", async () => {
    mocks.sendPaymentRejectedEmail.mockRejectedValue(new MailDeliveryError("permanent"));

    await expect(
      runTaskHandler(
        task({
          template: "payment_rejected",
          to: "fan@example.com",
          locale: "en",
          params: { tierName: "Supporter", reviewNote: null },
        }),
      ),
    ).rejects.toMatchObject({
      message: "Email delivery failed permanently",
      classification: "permanent",
    } satisfies Partial<PermanentTaskError>);
  });

  it("keeps transient SMTP failures retryable while stripping raw transport details", async () => {
    mocks.sendPaymentRejectedEmail.mockRejectedValue(
      new Error("recipient fan@example.com rejected; body=private"),
    );

    await expect(
      runTaskHandler(
        task({
          template: "payment_rejected",
          to: "fan@example.com",
          locale: "en",
          params: { tierName: "Supporter", reviewNote: null },
        }),
      ),
    ).rejects.toMatchObject({
      message: "SMTP delivery failed",
      kind: "transient",
    });
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

  it("dispatches auth login-code email tasks without recipient or code in the payload", async () => {
    mocks.deliverLoginCodeEmailTask.mockResolvedValue(
      "Login code was superseded; delivery skipped",
    );
    const payload = {
      version: 1,
      codeId: "550e8400-e29b-41d4-a716-446655440000",
      encryptedCode: "encrypted",
      locale: "zh",
    } as const;

    const result = await runTaskHandler(task(payload, "auth.login_code_email"));

    expect(mocks.deliverLoginCodeEmailTask).toHaveBeenCalledWith(payload, {
      taskId: "11111111-1111-4111-8111-111111111111",
      lockToken: "worker",
    });
    expect(JSON.stringify(payload)).not.toContain("@");
    expect(result.note).toContain("superseded");
  });

  it("rejects malformed auth login-code email task payloads permanently", async () => {
    await expect(
      runTaskHandler(
        task(
          {
            version: 1,
            codeId: "not-a-uuid",
            encryptedCode: "encrypted",
          },
          "auth.login_code_email",
        ),
      ),
    ).rejects.toThrow("Invalid auth.login_code_email payload");
    expect(mocks.deliverLoginCodeEmailTask).not.toHaveBeenCalled();
  });

  it("dispatches provider inbox tasks by row UUID", async () => {
    const eventRowId = "550e8400-e29b-41d4-a716-446655440000";
    await runTaskHandler(task({ eventRowId }, "payment_provider_event.dispatch"));
    expect(mocks.dispatchPaymentProviderEvent).toHaveBeenCalledWith(eventRowId);
  });

  it("defers provider inbox tasks when the event row is busy", async () => {
    const eventRowId = "550e8400-e29b-41d4-a716-446655440000";
    mocks.dispatchPaymentProviderEvent.mockRejectedValue(
      new ApiError(503, "paymentProviderEventBusy", {
        leaseUntil: "2026-06-25T08:00:00.000Z",
      }),
    );

    const result = await runTaskHandler(task({ eventRowId }, "payment_provider_event.dispatch"));

    expect(mocks.dispatchPaymentProviderEvent).toHaveBeenCalledWith(eventRowId);
    expect(result.deferUntil).toEqual(new Date("2026-06-25T08:00:00.250Z"));
  });

  it("reuses the deduplicated reconcile task row by deferring it after success", async () => {
    const result = await runTaskHandler(task({}, "subscription.reconcile"));
    expect(mocks.reconcileSubscriptions).toHaveBeenCalledOnce();
    expect(result.deferUntil).toEqual(new Date("2026-06-25T08:00:00.000Z"));
  });

  it("propagates reconciliation failures so the durable task retry policy applies", async () => {
    mocks.reconcileSubscriptions.mockRejectedValue(new Error("provider unavailable"));
    await expect(runTaskHandler(task({}, "subscription.reconcile"))).rejects.toThrow(
      "provider unavailable",
    );
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
