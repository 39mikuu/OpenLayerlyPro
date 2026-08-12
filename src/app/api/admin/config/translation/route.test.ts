import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getTranslationAdminView: vi.fn(),
  requireCurrentConfigRevision: vi.fn(),
  saveTranslationConfig: vi.fn(),
  clearTranslationConfig: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/modules/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/config")>();
  return {
    ...original,
    getTranslationAdminView: mocks.getTranslationAdminView,
    requireCurrentConfigRevision: mocks.requireCurrentConfigRevision,
    saveTranslationConfig: mocks.saveTranslationConfig,
    clearTranslationConfig: mocks.clearTranslationConfig,
  };
});

import { GET, PUT } from "./route";

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/admin/config/translation", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("admin translation config API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.requireCurrentConfigRevision.mockResolvedValue(undefined);
    mocks.saveTranslationConfig.mockResolvedValue(4);
    mocks.getTranslationAdminView.mockResolvedValue({
      revision: 4,
      enabled: false,
      provider: "openai-compatible",
      model: "translation-model",
      endpoint: "https://api.example.com/v1",
      monthlyCharLimit: 100_000,
      directPublishEnabled: false,
      showMachineTranslationLabel: false,
      configured: true,
      hasDbOverride: true,
      apiKeySet: true,
    });
  });

  it("returns apiKeySet without exposing the plaintext key", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: { apiKeySet: true, configured: true },
    });
    expect(JSON.stringify(body)).not.toContain("provider-secret");
    expect(body.data).not.toHaveProperty("apiKey");
  });

  it("saves provider configuration and returns only the safe admin view", async () => {
    const response = await PUT(
      request({
        revision: 4,
        enabled: true,
        provider: "openai-compatible",
        apiKey: "provider-secret",
        model: "translation-model",
        endpoint: "https://api.example.com/v1",
        monthlyCharLimit: 100_000,
        directPublishEnabled: true,
        showMachineTranslationLabel: true,
      }),
    );
    const body = await response.json();

    expect(mocks.saveTranslationConfig).toHaveBeenCalledWith(
      {
        enabled: true,
        provider: "openai-compatible",
        apiKey: "provider-secret",
        model: "translation-model",
        endpoint: "https://api.example.com/v1",
        monthlyCharLimit: 100_000,
        directPublishEnabled: true,
        showMachineTranslationLabel: true,
      },
      4,
    );
    expect(body.data).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("provider-secret");
  });

  it("requires a revision and returns 409 for a stale save", async () => {
    const missing = await PUT(request({ enabled: false }));
    expect(missing.status).toBe(400);
    expect(mocks.saveTranslationConfig).not.toHaveBeenCalled();

    mocks.requireCurrentConfigRevision.mockRejectedValueOnce(new ApiError(409, "configConflict"));
    const stale = await PUT(request({ revision: 3, enabled: false }));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ ok: false, code: "configConflict" });
    expect(mocks.saveTranslationConfig).not.toHaveBeenCalled();
  });
});
