import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AdminListCursorScope,
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/modules/admin/pagination";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listMembershipsPage: vi.fn(),
  listPaymentRequestsPage: vi.fn(),
  listFilesPage: vi.fn(),
  listQuarantinedFilesPage: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/membership", () => ({
  listMembershipsPage: mocks.listMembershipsPage,
}));
vi.mock("@/modules/payment", () => ({
  listPaymentRequestsPage: mocks.listPaymentRequestsPage,
}));
vi.mock("@/modules/file", () => ({
  listFilesPage: mocks.listFilesPage,
  listQuarantinedFilesPage: mocks.listQuarantinedFilesPage,
}));

import { GET as getFiles } from "./files/route";
import { GET as getMemberships } from "./memberships/route";
import { GET as getPayments } from "./payment-requests/route";

const cursorBase = {
  version: 1 as const,
  timestamp: "2026-07-02T01:02:03.000004Z",
  id: "11111111-1111-4111-8111-111111111111",
};

function cursor(scope: AdminListCursorScope): string {
  return encodeAdminListCursor({ ...cursorBase, scope });
}

function request(path: string, params: Record<string, string>): NextRequest {
  const url = new URL(path, "http://localhost");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new NextRequest(url);
}

async function expectInvalidCursor(response: Response) {
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    code: "invalidCursor",
  });
}

describe("admin pagination API cursor validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({});
    mocks.listMembershipsPage.mockImplementation(async ({ cursor: value }) => {
      decodeAdminListCursor(value, "memberships");
      return { items: [], nextCursor: null };
    });
    mocks.listPaymentRequestsPage.mockImplementation(async (options) => {
      decodeAdminListCursor(
        options.cursor,
        options.status === "pending_review" ? "payments:pending" : "payments:history",
      );
      return { items: [], nextCursor: null };
    });
    mocks.listFilesPage.mockImplementation(async ({ cursor: value }) => {
      decodeAdminListCursor(value, "files:active");
      return { items: [], nextCursor: null };
    });
    mocks.listQuarantinedFilesPage.mockImplementation(async ({ cursor: value }) => {
      decodeAdminListCursor(value, "files:quarantined");
      return { items: [], nextCursor: null };
    });
  });

  it.each([
    ["memberships", () => getMemberships(request("/api/admin/memberships", { cursor: "*" }))],
    [
      "payment requests",
      () =>
        getPayments(
          request("/api/admin/payment-requests", {
            status: "pending_review",
            cursor: "*",
          }),
        ),
    ],
    ["files", () => getFiles(request("/api/admin/files", { cursor: "*" }))],
  ])("returns invalidCursor for a malformed %s cursor", async (_name, call) => {
    await expectInvalidCursor(await call());
  });

  it("rejects a membership cursor at the payment API", async () => {
    await expectInvalidCursor(
      await getPayments(
        request("/api/admin/payment-requests", {
          status: "pending_review",
          cursor: cursor("memberships"),
        }),
      ),
    );
  });

  it("rejects a pending cursor at the history API", async () => {
    await expectInvalidCursor(
      await getPayments(
        request("/api/admin/payment-requests", {
          excludeStatus: "pending_review",
          cursor: cursor("payments:pending"),
        }),
      ),
    );
  });

  it("rejects an active-file cursor at the quarantined API", async () => {
    await expectInvalidCursor(
      await getFiles(
        request("/api/admin/files", {
          quarantined: "true",
          cursor: cursor("files:active"),
        }),
      ),
    );
  });
});
