import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), listMyPaymentRequests: vi.fn() }));

vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/payment", () => ({ listMyPaymentRequests: mocks.listMyPaymentRequests }));

import { GET } from "./route";

describe("me payment requests API serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
  });

  it("exposes structured fields without storage data", async () => {
    mocks.listMyPaymentRequests.mockResolvedValue([
      {
        request: {
          reviewNote:
            'payment_rejection:v1:{"rejectReasonCode":"wrong_amount","rejectDetails":"short"}',
        },
        tier: {},
      },
    ]);
    const json = await (await GET()).json();
    expect(json.data[0].request).toMatchObject({
      reviewNote: "wrong_amount: short",
      rejectReasonCode: "wrong_amount",
      rejectDetails: "short",
    });
    expect(JSON.stringify(json)).not.toContain("payment_rejection:");
  });

  it("redacts malformed prefixed notes", async () => {
    mocks.listMyPaymentRequests.mockResolvedValue([
      { request: { reviewNote: "payment_rejection:v1:{" }, tier: {} },
    ]);
    const json = await (await GET()).json();
    expect(json.data[0].request.reviewNote).toBeNull();
  });
});
