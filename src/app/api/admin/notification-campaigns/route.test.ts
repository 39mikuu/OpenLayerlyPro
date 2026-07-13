import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listNotificationCampaignAdminSummaries: vi.fn(),
  getNotificationCampaignAdminSummary: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/notifications/admin", () => ({
  listNotificationCampaignAdminSummaries: mocks.listNotificationCampaignAdminSummaries,
  getNotificationCampaignAdminSummary: mocks.getNotificationCampaignAdminSummary,
}));

import { GET as GET_DETAIL } from "./[id]/route";
import { GET as GET_LIST } from "./route";

describe("admin notification campaign APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.listNotificationCampaignAdminSummaries.mockResolvedValue([]);
    mocks.getNotificationCampaignAdminSummary.mockResolvedValue(null);
  });

  it("requires admin access", async () => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(403, "adminRequired"));

    const response = await GET_LIST();

    expect(response.status).toBe(403);
    expect(mocks.listNotificationCampaignAdminSummaries).not.toHaveBeenCalled();
  });

  it("returns only safe aggregate campaign data", async () => {
    mocks.listNotificationCampaignAdminSummaries.mockResolvedValue([
      {
        id: "campaign-1",
        postId: "post-1",
        postTitle: "Public title",
        postSlug: "public-title",
        source: "manual_publish",
        status: "sending",
        publishedAt: new Date("2026-07-12T00:00:00.000Z"),
        cursorUserId: null,
        expansionCompletedAt: null,
        completedAt: null,
        createdAt: new Date("2026-07-12T00:00:00.000Z"),
        updatedAt: new Date("2026-07-12T00:00:00.000Z"),
        lastError: null,
        deliveryCounts: { queued: 2 },
        attemptCounts: { accepted: 1 },
        suppressionCount: 0,
      },
    ]);

    const response = await GET_LIST();
    const body = await response.json();

    expect(body.data[0]).not.toHaveProperty("payloadJson");
    expect(body.data[0]).not.toHaveProperty("email");
    expect(body.data[0]).not.toHaveProperty("recipientEmail");
    expect(body.data[0]).not.toHaveProperty("smtpResponse");
    expect(body.data[0]).not.toHaveProperty("unsubscribeToken");
  });

  it("returns 404 for missing detail rows", async () => {
    const response = await GET_DETAIL(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    });

    expect(response.status).toBe(404);
  });
});
