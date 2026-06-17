import { ApiError } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getTurnstileConfig } from "@/modules/config";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const VERIFY_IP_LIMIT = 30;
const VERIFY_GLOBAL_LIMIT = 1000;
const VERIFY_IP_WINDOW_MS = 10 * 60 * 1000;

type SiteverifyResponse = {
  success: boolean;
  "error-codes"?: string[];
};

/**
 * 调用 Cloudflare Siteverify 验证 Turnstile token。
 * 网络异常或非 200 响应一律视为验证失败，不抛出异常、不输出 secret/token。
 */
export async function verifyTurnstileToken(
  secretKey: string,
  token: string,
  remoteIp?: string | null,
): Promise<boolean> {
  if (!secretKey) return false;

  const params = new URLSearchParams();
  params.set("secret", secretKey);
  params.set("response", token);
  if (remoteIp) params.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch {
    console.error("Turnstile siteverify 请求失败");
    return false;
  }
}

/**
 * 人机验证守卫：
 * - 最终生效配置 enabled=false 时直接放行；
 * - token 缺失返回 400；
 * - 调用 Siteverify 前先做轻量 IP 限流，避免攻击者大量触发外部校验请求；
 * - 验证失败返回 403。
 */
export async function assertTurnstile(
  token: string | null | undefined,
  ip?: string | null,
): Promise<void> {
  const config = await getTurnstileConfig();
  if (!config.enabled) return;

  if (!token) {
    throw new ApiError(400, "turnstileRequired");
  }

  const limitKey = ip ? `turnstile-ip:${ip}` : "turnstile-global";
  const limit = ip ? VERIFY_IP_LIMIT : VERIFY_GLOBAL_LIMIT;
  if (!rateLimit(limitKey, limit, VERIFY_IP_WINDOW_MS)) {
    throw new ApiError(429, "requestRateLimited");
  }

  const ok = config.secretKey ? await verifyTurnstileToken(config.secretKey, token, ip) : false;
  if (!ok) {
    throw new ApiError(403, "turnstileFailed");
  }
}
