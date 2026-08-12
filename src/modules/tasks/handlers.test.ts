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
  reconcileStorageUploadJournal: vi.fn(),
  sendMembershipActivatedEmail: vi.fn(),
  sendMembershipRevokedEmail: vi.fn(),
  sendPaymentRejectedEmail: vi.fn(),
  sendRenewalReminderEmail: vi.fn(),
  dispatchPaymentProviderEvent: vi.fn(),
  deliverLoginCodeEmailTask: vi.fn(),
  deliverMagicLinkEmailTask: vi.fn(),
  resolveMagicLinkRequestTask: vi.fn(),
  reconcileSubscriptions: vi.fn(),
  nextSubscriptionReconcileAt: vi.fn(),
  handleCampaignExpandTask: vi.fn(),
  handleCampaignFinalizeTask: vi.fn(),
  handleNotificationDeliveryTask: vi.fn(),
  createCampaignForPublishedPostTx: vi.fn(),
}));

vi.mock("@/modules/auth/login-code", () => ({
  deliverLoginCodeEmailTask: mocks.deliverLoginCodeEmailTask,
}));
vi.mock("@/modules/auth/magic-link", () => ({
  deliverMagicLinkEmailTask: mocks.deliverMagicLinkEmailTask,
  resolveMagicLinkRequestTask: mocks.resolveMagicLinkRequestTask,
}));
vi.mock("@/modules/file/cleanup", () => ({
  cleanupOrphanFile: mocks.cleanupOrphanFile,
  deleteStorageObject: mocks.deleteStorageObject,
  UnsupportedOrphanCleanupPurposeError: class UnsupportedOrphanCleanupPurposeError extends Error {},
}));
vi.mock("@/modules/file/uploadJournal", () => ({
  reconcileStorageUploadJournal: mocks.reconcileStorageUploadJournal,
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
vi.mock("@/modules/notifications", () => ({
  createCampaignForPublishedPostTx: mocks.createCampaignForPublishedPostTx,
  handleCampaignExpandTask: mocks.handleCampaignExpandTask,
  handleCampaignFinalizeTask: mocks.handleCampaignFinalizeTask,
  handleNotificationDeliveryTask: mocks.handleNotificationDeliveryTask,
}));

import type { Task } from "@/db/schema";
import { ApiError } from "@/lib/api";

import { runTaskHandler as runTaskHandlerWithOwnership } from "./handlers";
import { TaskOwnershipLostError } from "./ownership";
import { ownedTaskExecutionContext } from "./ownership.test-helper";

const runTaskHandler = (task: Parameters<typeof runTaskHandlerWithOwnership>[0]) =>
  runTaskHandlerWithOwnership(task, ownedTaskExecutionContext());

function task(
  payloadJson: Record<string, unknown>,
  kind = "email",
  createdAt = new Date(),
  queueClass: Task["queueClass"] = "transactional",
): Task {
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
    priority: kind === "auth.login_code_email" ? 0 : 10,
    queueClass,
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
    mocks.reconcileStorageUploadJournal.mockResolvedValue({ outcome: "deleted" });
    mocks.dispatchPaymentProviderEvent.mockResolvedValue(undefined);
    mocks.deliverLoginCodeEmailTask.mockResolvedValue(undefined);
    mocks.deliverMagicLinkEmailTask.mockResolvedValue(undefined);
    mocks.resolveMagicLinkRequestTask.mockResolvedValue(undefined);
    mocks.reconcileSubscriptions.mockResolvedValue(0);
    mocks.nextSubscriptionReconcileAt.mockReturnValue(new Date("2026-06-25T08:00:00.000Z"));
    mocks.handleCampaignExpandTask.mockResolvedValue({});
    mocks.handleCampaignFinalizeTask.mockResolvedValue({});
    mocks.handleNotificationDeliveryTask.mockResolvedValue({});
    mocks.createCampaignForPublishedPostTx.mockResolvedValue(null);
  });

  it("rejects raw-recipient v1 business email payloads permanently", async () => {
    await expect(
      runTaskHandler(
        task({
          template: "payment_rejected",
          to: "fan@example.com",
          locale: "ja",
          params: { tierName: "Supporter", reviewNote: null },
        }),
      ),
    ).rejects.toThrow("Invalid email payload");
    expect(mocks.sendPaymentRejectedEmail).not.toHaveBeenCalled();
  });

  it("rejects malformed v2 business email payloads before SMTP", async () => {
    await expect(
      runTaskHandler(
        task({
          version: 2,
          template: "payment_rejected",
          paymentRequestId: "not-a-uuid",
          reviewedAt: "2026-07-12T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("Invalid email payload");
    expect(mocks.sendPaymentRejectedEmail).not.toHaveBeenCalled();
  });

  it("rejects legacy membership activation payloads before SMTP", async () => {
    await expect(
      runTaskHandler(
        task({
          template: "membership_activated",
          to: "fan@example.com",
          locale: "ja",
          params: {
            tierName: "Supporter",
            endsAt: "2026-07-18T10:00:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("Invalid email payload");
    expect(mocks.sendMembershipActivatedEmail).not.toHaveBeenCalled();
  });

  it("rejects legacy membership revocation payloads before SMTP", async () => {
    await expect(
      runTaskHandler(
        task({
          template: "membership_revoked",
          to: "fan@example.com",
          locale: "zh",
          params: { tierName: "Supporter" },
        }),
      ),
    ).rejects.toThrow("Invalid email payload");
    expect(mocks.sendMembershipRevokedEmail).not.toHaveBeenCalled();
  });

  it("rejects legacy payment rejection payloads before SMTP", async () => {
    await expect(
      runTaskHandler(
        task({
          template: "payment_rejected",
          to: "fan@example.com",
          locale: "en",
          params: { tierName: "Supporter", reviewNote: "Proof unclear" },
        }),
      ),
    ).rejects.toThrow("Invalid email payload");
    expect(mocks.sendPaymentRejectedEmail).not.toHaveBeenCalled();
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

  it("does not start storage deletion after task ownership is lost", async () => {
    const payload = {
      storageDriver: "s3",
      bucket: "private",
      objectKey: "content/2026/06/image.png",
    } as const;
    const execution = ownedTaskExecutionContext();
    execution.assertOwnership = vi.fn().mockRejectedValue(new TaskOwnershipLostError());

    await expect(
      runTaskHandlerWithOwnership(task(payload, "storage.delete_object"), execution),
    ).rejects.toBeInstanceOf(TaskOwnershipLostError);
    expect(mocks.deleteStorageObject).not.toHaveBeenCalled();
  });

  it("reconciles an upload journal through the task ownership fence", async () => {
    const journalId = "550e8400-e29b-41d4-a716-446655440000";
    const execution = ownedTaskExecutionContext();

    const result = await runTaskHandlerWithOwnership(
      task({ journalId }, "storage.reconcile_upload", new Date(), "maintenance"),
      execution,
    );

    expect(mocks.reconcileStorageUploadJournal).toHaveBeenCalledWith(journalId, {
      assertOwnership: execution.assertOwnership,
    });
    expect(result.note).toContain("deleted");
  });

  it("defers an upload journal when its authoritative grace period has not elapsed", async () => {
    const deferUntil = new Date("2026-06-26T08:00:00.000Z");
    mocks.reconcileStorageUploadJournal.mockResolvedValue({ outcome: "defer", deferUntil });

    const result = await runTaskHandler(
      task(
        { journalId: "550e8400-e29b-41d4-a716-446655440000" },
        "storage.reconcile_upload",
        new Date(),
        "maintenance",
      ),
    );

    expect(result).toEqual({ deferUntil });
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
      assertTaskOwnership: expect.any(Function),
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

  it("dispatches protocol-v2 Magic Link delivery only when the top-level protocol marker is exact", async () => {
    const payload = {
      version: 1,
      deliveryProtocol: 2,
      tokenId: "550e8400-e29b-41d4-a716-446655440000",
      encryptedToken: "encrypted",
      locale: "ja",
    } as const;

    await runTaskHandler(task(payload, "auth.magic_link_email", new Date(), "auth_delivery_v2"));

    expect(mocks.deliverMagicLinkEmailTask).toHaveBeenCalledWith(payload, {
      taskId: "11111111-1111-4111-8111-111111111111",
      lockToken: "worker",
    });
  });

  it("rejects an unknown Magic Link delivery protocol instead of downgrading it to legacy", async () => {
    await expect(
      runTaskHandler(
        task(
          {
            version: 1,
            deliveryProtocol: 3,
            tokenId: "550e8400-e29b-41d4-a716-446655440000",
            encryptedToken: "encrypted",
          },
          "auth.magic_link_email",
        ),
      ),
    ).rejects.toThrow("Invalid auth.magic_link_email payload");
    expect(mocks.deliverMagicLinkEmailTask).not.toHaveBeenCalled();
  });

  it("rejects a bypassed v2 task graph before SMTP", async () => {
    await expect(
      runTaskHandler(
        task(
          {
            version: 1,
            deliveryProtocol: 2,
            tokenId: "550e8400-e29b-41d4-a716-446655440000",
            encryptedToken: "encrypted",
            email: "leak@example.test",
          },
          "auth.magic_link_email",
          new Date(),
          "auth_delivery_v2",
        ),
      ),
    ).rejects.toThrow("Invalid auth.magic_link_email payload");
    expect(mocks.deliverMagicLinkEmailTask).not.toHaveBeenCalled();

    await expect(
      runTaskHandler(
        task(
          {
            version: 1,
            deliveryProtocol: 2,
            tokenId: "550e8400-e29b-41d4-a716-446655440000",
            encryptedToken: "encrypted",
          },
          "auth.magic_link_email",
          new Date(),
          "transactional",
        ),
      ),
    ).rejects.toThrow("Invalid auth.magic_link_email task graph");
    expect(mocks.deliverMagicLinkEmailTask).not.toHaveBeenCalled();
  });

  it("does not downgrade an unmarked v2-queue Magic Link task into legacy SMTP", async () => {
    await expect(
      runTaskHandler(
        task(
          {
            version: 1,
            tokenId: "550e8400-e29b-41d4-a716-446655440000",
            encryptedToken: "encrypted",
          },
          "auth.magic_link_email",
          new Date(),
          "auth_delivery_v2",
        ),
      ),
    ).rejects.toThrow("Invalid auth.magic_link_email task graph");
    expect(mocks.deliverMagicLinkEmailTask).not.toHaveBeenCalled();
  });

  it("dispatches Magic Link intake from an email-free request payload", async () => {
    const payload = {
      version: 1,
      requestId: "550e8400-e29b-41d4-a716-446655440000",
    } as const;

    await runTaskHandler(task(payload, "auth.magic_link_request", new Date(), "auth_intake"));

    expect(mocks.resolveMagicLinkRequestTask).toHaveBeenCalledWith(payload, {
      taskId: "11111111-1111-4111-8111-111111111111",
      lockToken: "worker",
    });
  });

  it("rejects an intake task with an email-bearing bypass payload", async () => {
    await expect(
      runTaskHandler(
        task(
          {
            version: 1,
            requestId: "550e8400-e29b-41d4-a716-446655440000",
            email: "leak@example.test",
          },
          "auth.magic_link_request",
          new Date(),
          "auth_intake",
        ),
      ),
    ).rejects.toThrow("Invalid auth.magic_link_request payload");
    expect(mocks.resolveMagicLinkRequestTask).not.toHaveBeenCalled();
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
