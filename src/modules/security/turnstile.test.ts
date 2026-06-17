import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rateLimit } from "@/lib/rate-limit";
import { getTurnstileConfig } from "@/modules/config";

import { assertTurnstile } from "./turnstile";

vi.mock("@/modules/config", () => ({
  getTurnstileConfig: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(),
}));

const mockedGetConfig = vi.mocked(getTurnstileConfig);
const mockedRateLimit = vi.mocked(rateLimit);

describe("assertTurnstile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRateLimit.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("最终配置关闭时直接放行且不调用 Siteverify", async () => {
    mockedGetConfig.mockResolvedValue({
      enabled: false,
      siteKey: "env-site",
      secretKey: "env-secret",
    });
    await expect(assertTurnstile(undefined, "turnstile-disabled")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("开启但 token 缺失时返回 400", async () => {
    mockedGetConfig.mockResolvedValue({
      enabled: true,
      siteKey: "site",
      secretKey: "secret",
    });
    await expect(assertTurnstile(undefined, "turnstile-missing")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("Siteverify 拒绝伪 token 时返回 403 且错误不泄露 secret", async () => {
    mockedGetConfig.mockResolvedValue({
      enabled: true,
      siteKey: "site",
      secretKey: "secret",
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = assertTurnstile("fake-token", "turnstile-fake");
    await expect(result).rejects.toMatchObject({ status: 403 });
    await expect(result).rejects.not.toThrow("secret");
    const body = String(vi.mocked(fetch).mock.calls[0][1]?.body);
    expect(body).toContain("secret=secret");
    expect(body).toContain("response=fake-token");
  });

  it("Siteverify 成功时放行", async () => {
    mockedGetConfig.mockResolvedValue({
      enabled: true,
      siteKey: "site",
      secretKey: "secret",
    });
    vi.mocked(fetch).mockImplementation(async () => {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await expect(assertTurnstile("valid-token", "turnstile-valid")).resolves.toBeUndefined();
  });

  it("调用 Siteverify 前保留 IP 限流", async () => {
    mockedGetConfig.mockResolvedValue({
      enabled: true,
      siteKey: "site",
      secretKey: "secret",
    });
    vi.mocked(fetch).mockImplementation(async () => {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    mockedRateLimit.mockReturnValueOnce(false);

    await expect(assertTurnstile("token-31", "turnstile-rate-limit")).rejects.toMatchObject({
      status: 429,
    });
    expect(mockedRateLimit).toHaveBeenCalledWith("turnstile-ip:turnstile-rate-limit", 30, 600_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("可信 IP 存在时使用 per-IP Turnstile 限流", async () => {
    mockedGetConfig.mockResolvedValue({
      enabled: true,
      siteKey: "site",
      secretKey: "secret",
    });
    vi.mocked(fetch).mockImplementation(async () => {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await assertTurnstile("valid-token", "203.0.113.10");

    expect(mockedRateLimit).toHaveBeenCalledWith("turnstile-ip:203.0.113.10", 30, 600_000);
  });

  it("可信 IP 缺失时不使用 turnstile-ip:unknown 共享桶", async () => {
    mockedGetConfig.mockResolvedValue({
      enabled: true,
      siteKey: "site",
      secretKey: "secret",
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await assertTurnstile("valid-token", null);

    expect(mockedRateLimit).toHaveBeenCalledWith("turnstile-global", 1000, 600_000);
    expect(mockedRateLimit).not.toHaveBeenCalledWith(
      "turnstile-ip:unknown",
      expect.anything(),
      expect.anything(),
    );
  });

  it("可信 IP 缺失时不会用 30 次低阈值阻断全站", async () => {
    mockedGetConfig.mockResolvedValue({
      enabled: true,
      siteKey: "site",
      secretKey: "secret",
    });
    vi.mocked(fetch).mockImplementation(async () => {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    for (let i = 0; i < 31; i += 1) {
      await expect(assertTurnstile(`token-${i}`, undefined)).resolves.toBeUndefined();
    }

    expect(mockedRateLimit).toHaveBeenCalledTimes(31);
    expect(mockedRateLimit).toHaveBeenLastCalledWith("turnstile-global", 1000, 600_000);
  });
});
