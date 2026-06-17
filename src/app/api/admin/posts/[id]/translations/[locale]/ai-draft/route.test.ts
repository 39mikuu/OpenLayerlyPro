import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  generateAiTranslationDraft: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/translation/ai-draft", () => ({
  generateAiTranslationDraft: mocks.generateAiTranslationDraft,
}));

import { POST } from "./route";

const draft = {
  id: "translation-ja-draft",
  postId: "post-1",
  locale: "ja",
  title: "日本語タイトル",
  summary: "日本語概要",
  body: "日本語本文",
  status: "draft",
  source: "machine",
  sourceUpdatedAt: new Date("2026-02-01T00:00:00Z"),
  publishedAt: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
};

function request(): NextRequest {
  return new Request("http://localhost/api/admin/posts/post-1/translations/ja/ai-draft", {
    method: "POST",
  }) as unknown as NextRequest;
}

function context(locale = "ja") {
  return { params: Promise.resolve({ id: "post-1", locale }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
  mocks.generateAiTranslationDraft.mockResolvedValue(draft);
});

describe("POST admin AI translation draft", () => {
  it.each([
    [401, "authRequired"],
    [403, "adminRequired"],
  ])("rejects non-admin access with %s", async (status, code) => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(status, code));

    const response = await POST(request(), context());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code });
    expect(mocks.generateAiTranslationDraft).not.toHaveBeenCalled();
  });

  it("returns a generated Japanese draft without publishing it", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.generateAiTranslationDraft).toHaveBeenCalledWith("post-1", "ja");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        locale: "ja",
        status: "draft",
        source: "machine",
        publishedAt: null,
      },
    });
  });

  it.each([
    ["translationDisabled", 400],
    ["translationConfigIncomplete", 400],
  ])("returns the stable %s configuration error", async (code, status) => {
    mocks.generateAiTranslationDraft.mockRejectedValue(new ApiError(status, code));

    const response = await POST(request(), context());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code });
  });

  it("does not leak provider secrets from unexpected errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.generateAiTranslationDraft.mockRejectedValue(
      new Error("provider rejected apiKey sk-secret-value"),
    );

    const response = await POST(request(), context());
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(body).toContain("internalError");
    expect(body).not.toContain("sk-secret-value");
    log.mockRestore();
  });
});
