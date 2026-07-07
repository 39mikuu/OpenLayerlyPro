import { describe, expect, it, vi } from "vitest";

import { buildTranslationPrompt, createOpenAiCompatibleProvider } from "./openai-compatible";

describe("OpenAI-compatible translation provider", () => {
  it("builds a strict Markdown-preserving prompt", () => {
    const prompt = buildTranslationPrompt({
      text: "# 标题\n\n正文",
      sourceLocale: "zh",
      targetLocale: "ja",
    });

    expect(prompt).toContain("Translate");
    expect(prompt).toContain("Japanese");
    expect(prompt).toContain("Preserve all Markdown syntax exactly");
    expect(prompt).toContain("Preserve every OLP_MD_*_END token exactly");
    expect(prompt).toContain("Preserve paragraph breaks and line breaks");
    expect(prompt).toContain("Do not add, remove");
    expect(prompt).toContain("Do not explain");
    expect(prompt).toContain("# 标题\n\n正文");
  });

  it("translates content to Japanese through chat completions", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "# タイトル\n\n本文" } }],
      }),
    })) as unknown as typeof fetch;
    const provider = createOpenAiCompatibleProvider(
      {
        apiKey: "provider-secret",
        endpoint: "https://api.example.com/v1",
        model: "translation-model",
      },
      fetcher,
    );

    await expect(
      provider.translate({
        text: "# 标题\n\n正文",
        sourceLocale: "zh",
        targetLocale: "ja",
      }),
    ).resolves.toBe("# タイトル\n\n本文");

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer provider-secret",
        }),
      }),
    );
  });

  it.each([
    ["not a valid URL", "not a url"],
    ["a query string", "https://api.example.com/v1?tenant=abc"],
    ["embedded userinfo", "https://user:pass@api.example.com/v1"],
    ["a fragment", "https://api.example.com/v1#frag"],
    ["a non-http(s) scheme", "ftp://files.example.com/v1"],
  ])("refuses to call a legacy endpoint with %s", async (_label, endpoint) => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const provider = createOpenAiCompatibleProvider(
      {
        apiKey: "provider-secret",
        endpoint,
        model: "translation-model",
      },
      fetcher,
    );

    await expect(
      provider.translate({ text: "正文", sourceLocale: "zh", targetLocale: "ja" }),
    ).rejects.toMatchObject({ status: 400, code: "translationEndpointInvalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not leak the api key when the provider fails", async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 401,
    })) as unknown as typeof fetch;
    const provider = createOpenAiCompatibleProvider(
      {
        apiKey: "provider-secret",
        endpoint: "https://api.example.com/v1",
        model: "translation-model",
      },
      fetcher,
    );

    const error = await provider
      .translate({
        text: "正文",
        sourceLocale: "zh",
        targetLocale: "ja",
      })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      status: 502,
      code: "translationProviderFailed",
      params: { status: 401 },
    });
    expect(JSON.stringify(error)).not.toContain("provider-secret");
  });
});
