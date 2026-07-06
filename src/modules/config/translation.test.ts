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

  it.each([
    ["not a URL", "not a url"],
    ["a non-http(s) scheme", "ftp://files.example.com/v1"],
    ["a file scheme", "file:///etc/passwd"],
    ["embedded userinfo", "https://user:pass@api.example.com/v1"],
    ["a fragment", "https://api.example.com/v1#frag"],
    ["a query string", "https://api.example.com/v1?tenant=abc"],
  ])("rejects an endpoint with %s", async (_label, endpoint) => {
    mockedGet.mockResolvedValue(null);
    const { saveTranslationConfig } = await import("./translation");

    await expect(saveTranslationConfig({ endpoint })).rejects.toMatchObject({
      status: 400,
      code: "translationEndpointInvalid",
    });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("allows plain-HTTP endpoints on loopback and private hosts without warning", async () => {
    mockedGet.mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { saveTranslationConfig } = await import("./translation");

    for (const endpoint of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:4000/v1",
      "http://192.168.1.20:11434/v1",
      "http://10.0.0.5/v1",
      "http://172.16.0.9/v1",
      "http://ollama.internal/v1",
    ]) {
      await saveTranslationConfig({ endpoint });
    }

    expect(warn).not.toHaveBeenCalled();
    expect(mockedSet).toHaveBeenCalledTimes(6);
    warn.mockRestore();
  });

  it("warns (but still saves) when a public host is reached over plain HTTP", async () => {
    mockedGet.mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { saveTranslationConfig } = await import("./translation");

    await saveTranslationConfig({ endpoint: "http://api.example.com/v1" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(mockedSet).toHaveBeenCalledWith(
      "translation",
      expect.objectContaining({ endpoint: "http://api.example.com/v1" }),
    );
    warn.mockRestore();
  });

  it("keeps a legacy stored endpoint readable and re-savable when the input omits it", async () => {
    mockedGet.mockResolvedValue({ endpoint: "not a url" });
    const { getTranslationConfig, saveTranslationConfig } = await import("./translation");

    await expect(getTranslationConfig()).resolves.toMatchObject({ endpoint: "not a url" });
    await expect(saveTranslationConfig({ enabled: true })).resolves.toBeUndefined();
  });

  it("accepts the admin form resubmitting an unchanged legacy endpoint alongside other edits", async () => {
    // The real form always sends the endpoint field, even when the admin only
    // toggled another switch — an unchanged value must not fail validation.
    mockedGet.mockResolvedValue({ endpoint: "not a url", enabled: false });
    const { saveTranslationConfig } = await import("./translation");

    await saveTranslationConfig({ endpoint: "not a url", enabled: true });

    expect(mockedSet).toHaveBeenCalledWith(
      "translation",
      expect.objectContaining({ endpoint: "not a url", enabled: true }),
    );
  });

  it("validates strictly when a legacy endpoint is actually edited", async () => {
    mockedGet.mockResolvedValue({ endpoint: "not a url" });
    const { saveTranslationConfig } = await import("./translation");

    await expect(saveTranslationConfig({ endpoint: "still not a url" })).rejects.toMatchObject({
      status: 400,
      code: "translationEndpointInvalid",
    });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("clears the database override", async () => {
    const { clearTranslationConfig } = await import("./translation");
    await clearTranslationConfig();
    expect(mockedDelete).toHaveBeenCalledWith("translation");
  });
});
