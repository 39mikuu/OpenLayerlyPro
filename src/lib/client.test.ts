import { afterEach, describe, expect, it, vi } from "vitest";

import { installClientMessages } from "@/modules/i18n/client";
import { en } from "@/modules/i18n/messages/en";
import { ja } from "@/modules/i18n/messages/ja";

import { api, ApiError } from "./client";

function jsonResponse(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("client API localization", () => {
  afterEach(() => {
    installClientMessages(null);
    vi.unstubAllGlobals();
  });

  it("uses the active client catalog for stable API error codes", async () => {
    installClientMessages(en);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: false,
          code: "cooldownRateLimited",
          params: { seconds: 30 },
          error: "请等待 30 秒后重试。",
        }),
      ),
    );

    await expect(api("/api/test")).rejects.toThrow("Please wait 30 seconds before sending again.");
  });

  it("localizes malformed-response fallbacks without bundled locale imports", async () => {
    installClientMessages(ja);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 503 })),
    );

    await expect(api("/api/test")).rejects.toThrow("リクエストに失敗しました（503）");
  });

  it("keeps the server compatibility fallback before a catalog is installed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: false,
          code: "unknownFutureCode",
          error: "兼容错误信息",
        }),
      ),
    );

    await expect(api("/api/test")).rejects.toThrow("兼容错误信息");
  });

  it("exposes the stable error code so callers need not match localized text", async () => {
    installClientMessages(en);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            ok: false,
            code: "codeAttemptsExceeded",
            params: { rotateChallenge: 1 },
            error: "尝试次数过多。请稍后再试。",
          },
          429,
        ),
      ),
    );

    const rejected = api("/api/test");
    await expect(rejected).rejects.toBeInstanceOf(ApiError);
    await expect(rejected).rejects.toMatchObject({
      status: 429,
      code: "codeAttemptsExceeded",
      params: { rotateChallenge: 1 },
    });
    await expect(rejected).rejects.toThrow("Too many incorrect attempts. Please try again later.");
  });
});
