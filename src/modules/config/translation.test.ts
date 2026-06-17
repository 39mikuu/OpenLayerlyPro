import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

vi.mock("./store", () => ({
  getStoredGroup: vi.fn(),
  setStoredGroup: vi.fn(),
  deleteStoredGroup: vi.fn(),
}));

const mockedGet = vi.mocked(getStoredGroup);
const mockedSet = vi.mocked(setStoredGroup);
const mockedDelete = vi.mocked(deleteStoredGroup);

describe("translation config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("is disabled and unconfigured by default", async () => {
    mockedGet.mockResolvedValue(null);
    const { getTranslationConfig } = await import("./translation");

    await expect(getTranslationConfig()).resolves.toEqual({
      enabled: false,
      provider: "openai-compatible",
      apiKey: undefined,
      model: undefined,
      endpoint: undefined,
      monthlyCharLimit: undefined,
      directPublishEnabled: false,
      showMachineTranslationLabel: false,
      configured: false,
      hasDbOverride: false,
    });
  });

  it("admin view returns apiKeySet without plaintext apiKey", async () => {
    mockedGet.mockResolvedValue({
      enabled: true,
      provider: "openai-compatible",
      apiKey: "secret-key",
      model: "test-model",
      endpoint: "https://example.com/v1",
    });
    const { getTranslationAdminView } = await import("./translation");
    const view = await getTranslationAdminView();

    expect(view.apiKeySet).toBe(true);
    expect(view.configured).toBe(true);
    expect(view).not.toHaveProperty("apiKey");
    expect(JSON.stringify(view)).not.toContain("secret-key");
  });

  it("trims fields, stores limits, and preserves a masked api key", async () => {
    mockedGet.mockResolvedValue({
      apiKey: "old-secret",
      model: "old-model",
      endpoint: "https://old.example/v1",
    });
    const { saveTranslationConfig } = await import("./translation");

    await saveTranslationConfig({
      enabled: true,
      provider: "openai-compatible",
      apiKey: " ",
      model: " test-model ",
      endpoint: " https://example.com/v1/ ",
      monthlyCharLimit: 100_000,
      directPublishEnabled: true,
      showMachineTranslationLabel: true,
    });

    expect(mockedSet).toHaveBeenCalledWith("translation", {
      enabled: true,
      provider: "openai-compatible",
      apiKey: "old-secret",
      model: "test-model",
      endpoint: "https://example.com/v1",
      monthlyCharLimit: 100_000,
      directPublishEnabled: true,
      showMachineTranslationLabel: true,
    });
  });

  it("clears the database override", async () => {
    const { clearTranslationConfig } = await import("./translation");
    await clearTranslationConfig();
    expect(mockedDelete).toHaveBeenCalledWith("translation");
  });
});
