import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { getEnv } from "@/lib/env";
import {
  InvalidContentLengthError,
  InvalidJsonBodyError,
  InvalidMultipartBodyError,
  InvalidTextBodyError,
  RequestBodyReadError,
  RequestBodyTooLargeError,
} from "@/lib/request-body";
import { DEFAULT_LOCALE, translate } from "@/modules/i18n";

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, withJsonSecurityHeaders(init));
}

export type ApiErrorParams = Record<string, string | number>;

export function jsonError(status: number, code: string, params?: ApiErrorParams): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code,
      params,
      // Compatibility fallback for clients that do not understand stable error codes yet.
      error: translate(DEFAULT_LOCALE, `errors.${code}`, params),
    },
    withJsonSecurityHeaders({ status }),
  );
}

function withJsonSecurityHeaders(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  return { ...init, headers };
}

/**
 * 解析真实客户端 IP，**只信任已配置的代理层**。
 *
 * - `TRUSTED_PROXY_HEADER=x-forwarded-for`（默认）：按 `TRUSTED_PROXY_HOPS` 取
 *   `X-Forwarded-For` 列表中「右数第 N 个」条目（标准 trust-N-hops 语义）。
 *   `hops=0`（默认）表示不信任任何转发头，返回 null，杜绝伪造。配置跳数超过实际
 *   条目数时同样返回 null（失败即安全，绝不退回客户端可控的条目）。
 * - 单值头（`x-real-ip` / `cf-connecting-ip` / `true-client-ip`）：直接返回该头的值。
 *   这类头仅在源站不直接暴露、只接受可信边缘流量时才安全（见部署文档）。
 */
export function getClientIp(req: NextRequest): string | null {
  const env = getEnv();
  const header = env.TRUSTED_PROXY_HEADER;

  if (header !== "x-forwarded-for") {
    const value = req.headers.get(header)?.trim();
    return value ? value : null;
  }

  const hops = env.TRUSTED_PROXY_HOPS;
  if (hops <= 0) return null;

  const list = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const index = list.length - hops;
  return index >= 0 ? list[index] : null;
}

export function getUserAgent(req: NextRequest): string | null {
  return req.headers.get("user-agent");
}

export class ApiError extends Error {
  status: number;
  code: string;
  params?: ApiErrorParams;
  constructor(status: number, code: string, params?: ApiErrorParams) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof RequestBodyTooLargeError) {
    return jsonError(413, "requestBodyTooLarge");
  }
  if (err instanceof InvalidContentLengthError) {
    return jsonError(400, "invalidRequest", { field: "content-length" });
  }
  if (
    err instanceof InvalidJsonBodyError ||
    err instanceof InvalidTextBodyError ||
    err instanceof InvalidMultipartBodyError ||
    err instanceof RequestBodyReadError
  ) {
    return jsonError(400, "invalidRequest", { field: "body" });
  }
  if (err instanceof ApiError) {
    return jsonError(err.status, err.code, err.params);
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return jsonError(400, "invalidRequest", {
      field: first?.path.join(".") || "request",
    });
  }
  console.error(err);
  return jsonError(500, "internalError");
}
