import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";

vi.mock("@/db", () => ({
  getDb: vi.fn(),
}));

const mockedGetDb = vi.mocked(getDb);

function mockPaymentRequestRows(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ orderBy }));
  const leftJoin = vi.fn(() => ({ where }));
  const innerJoin = vi.fn(() => ({ leftJoin, where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  mockedGetDb.mockReturnValue({ select } as never);
  return { select, innerJoin, leftJoin };
}

describe("fan payment request reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the existing list query free of payment method joins", async () => {
    const query = mockPaymentRequestRows([]);
    const { listMyPaymentRequests } = await import("./index");

    await expect(listMyPaymentRequests("user-1")).resolves.toEqual([]);

    expect(query.select).toHaveBeenCalledTimes(1);
    expect(query.innerJoin).toHaveBeenCalledTimes(1);
    expect(query.leftJoin).not.toHaveBeenCalled();
  });

  it("left joins payment methods for the account order detail view", async () => {
    const rows = [
      {
        request: { id: "request-1" },
        tier: { id: "tier-1" },
        paymentMethod: { id: "method-1", name: "Manual transfer" },
      },
    ];
    const query = mockPaymentRequestRows(rows);
    const { listMyPaymentRequestDetails } = await import("./index");

    await expect(listMyPaymentRequestDetails("user-1")).resolves.toEqual(rows);

    expect(query.select).toHaveBeenCalledTimes(1);
    expect(query.innerJoin).toHaveBeenCalledTimes(1);
    expect(query.leftJoin).toHaveBeenCalledTimes(1);
  });
});
