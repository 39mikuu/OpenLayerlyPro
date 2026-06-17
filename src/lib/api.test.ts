import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError, handleApiError } from "./api";

function makeReq(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

async function loadGetClientIp() {
  const mod = await import("./api");
  return mod.getClientIp;
}

describe("handleApiError", () => {
  it("ApiError 映射为稳定 code、params 与兼容消息", async () => {
    const res = handleApiError(new ApiError(429, "cooldownRateLimited", { seconds: 30 }));
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      code: "cooldownRateLimited",
      params: { seconds: 30 },
      error: "发送过于频繁，请 30 秒后再试",
    });
  });

  it("ZodError 返回 400 并拼接字段路径", async () => {
    const result = z.object({ email: z.string().email() }).safeParse({ email: "bad" });
    expect(result.success).toBe(false);

    const res = handleApiError(result.error);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("invalidRequest");
    expect(body.error).toContain("email");
  });

  it("未知错误返回 500 中文兜底并记录日志", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(new Error("boom"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      code: "internalError",
      error: "服务器内部错误",
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("getClientIp 可信代理解析", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("默认 hops=0：即使有 XFF 也返回 null", async () => {
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBeNull();
  });

  it("hops=1：取最右条目，忽略客户端伪造的前缀", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const getClientIp = await loadGetClientIp();
    // 客户端伪造 1.2.3.4，反代追加真实访客 203.0.113.7
    expect(getClientIp(makeReq({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("hops=2：取右数第 2 个条目", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" }))).toBe(
      "203.0.113.7",
    );
    // 伪造前缀仍被丢弃
    expect(getClientIp(makeReq({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 10.0.0.2" }))).toBe(
      "203.0.113.7",
    );
  });

  it("hops 大于列表长度：返回 null（失败即安全）", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({ "x-forwarded-for": "9.9.9.9" }))).toBeNull();
  });

  it("空 XFF 列表：返回 null", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({ "x-forwarded-for": "" }))).toBeNull();
    expect(getClientIp(makeReq({ "x-forwarded-for": "  ,  , " }))).toBeNull();
  });

  it("缺失 XFF 头：返回 null", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({}))).toBeNull();
  });

  it("条目两侧空白被 trim", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({ "x-forwarded-for": "  203.0.113.7  " }))).toBe("203.0.113.7");
  });

  it("header 大小写归一化：大写请求头仍能命中", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({ "X-Forwarded-For": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("header=cf-connecting-ip：直接返回该头并忽略 XFF/hops", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    const getClientIp = await loadGetClientIp();
    expect(
      getClientIp(
        makeReq({ "CF-Connecting-IP": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
      ),
    ).toBe("203.0.113.7");
  });

  it("header=x-real-ip：返回 X-Real-IP", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("header=true-client-ip：返回 True-Client-IP", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "true-client-ip");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({ "true-client-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("单值头缺失或为空：返回 null", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    const getClientIp = await loadGetClientIp();
    expect(getClientIp(makeReq({}))).toBeNull();
    expect(getClientIp(makeReq({ "cf-connecting-ip": "   " }))).toBeNull();
  });
});
