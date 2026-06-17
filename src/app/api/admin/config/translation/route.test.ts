import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getTranslationAdminView: vi.fn(),
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
    mocks.getTranslationAdminView.mockResolvedValue({
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

    expect(mocks.saveTranslationConfig).toHaveBeenCalledWith({
      enabled: true,
      provider: "openai-compatible",
      apiKey: "provider-secret",
      model: "translation-model",
      endpoint: "https://api.example.com/v1",
      monthlyCharLimit: 100_000,
      directPublishEnabled: true,
      showMachineTranslationLabel: true,
    });
    expect(body.data).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("provider-secret");
  });
});
