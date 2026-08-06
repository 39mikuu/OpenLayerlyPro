import { describe, expect, it } from "vitest";

import {
  isExactLegacyMagicLinkDeliveryTask,
  isExactMagicLinkDeliveryV2Task,
  isExactMagicLinkIntakeTask,
} from "./magic-link-v2-task-graph";

const candidateId = "11111111-1111-4111-8111-111111111111";
const task = {
  kind: "auth.magic_link_email",
  queueClass: "auth_delivery_v2",
  payloadJson: {
    version: 1,
    deliveryProtocol: 2,
    tokenId: candidateId,
    encryptedToken: "ciphertext",
    locale: "en",
  },
};

describe("isExactMagicLinkDeliveryV2Task", () => {
  it("accepts only the exact task, queue, protocol, and candidate graph", () => {
    expect(isExactMagicLinkDeliveryV2Task(task, candidateId)).toBe(true);
    expect(
      isExactMagicLinkDeliveryV2Task(
        { ...task, payloadJson: { ...task.payloadJson, tokenId: "other-candidate" } },
        candidateId,
      ),
    ).toBe(false);
    expect(
      isExactMagicLinkDeliveryV2Task({ ...task, kind: "auth.login_code_email" }, candidateId),
    ).toBe(false);
    expect(
      isExactMagicLinkDeliveryV2Task({ ...task, queueClass: "transactional" }, candidateId),
    ).toBe(false);
    expect(
      isExactMagicLinkDeliveryV2Task(
        { ...task, payloadJson: { ...task.payloadJson, deliveryProtocol: 3 } },
        candidateId,
      ),
    ).toBe(false);
    expect(
      isExactMagicLinkDeliveryV2Task(
        { ...task, payloadJson: { ...task.payloadJson, email: "leak@example.test" } },
        candidateId,
      ),
    ).toBe(false);
  });

  it("requires the exact intake queue and an email-free payload", () => {
    const intake = {
      kind: "auth.magic_link_request",
      queueClass: "auth_intake",
      payloadJson: { version: 1, requestId: candidateId },
    };
    expect(isExactMagicLinkIntakeTask(intake, candidateId)).toBe(true);
    expect(
      isExactMagicLinkIntakeTask({ ...intake, queueClass: "transactional" }, candidateId),
    ).toBe(false);
    expect(
      isExactMagicLinkIntakeTask(
        { ...intake, payloadJson: { ...intake.payloadJson, email: "leak@example.test" } },
        candidateId,
      ),
    ).toBe(false);
  });

  it("permits a legacy task only on the legacy queue and never downgrades a v2 queue row", () => {
    const legacy = {
      kind: "auth.magic_link_email",
      queueClass: "transactional",
      dedupeKey: `auth-magic-link-email:${candidateId}`,
      payloadJson: {
        version: 1,
        tokenId: candidateId,
        encryptedToken: "ciphertext",
        locale: "zh",
      },
    };
    expect(isExactLegacyMagicLinkDeliveryTask(legacy, candidateId)).toBe(true);
    expect(
      isExactLegacyMagicLinkDeliveryTask(
        { ...legacy, queueClass: "auth_delivery_v2" },
        candidateId,
      ),
    ).toBe(false);
    expect(
      isExactLegacyMagicLinkDeliveryTask(
        { ...legacy, dedupeKey: "auth-magic-link-email:another-candidate" },
        candidateId,
      ),
    ).toBe(false);
    expect(
      isExactLegacyMagicLinkDeliveryTask(
        { ...legacy, payloadJson: { ...legacy.payloadJson, email: "leak@example.test" } },
        candidateId,
      ),
    ).toBe(false);
  });
});
