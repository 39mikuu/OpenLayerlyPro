import { NextRequest } from "next/server";
import { z } from "zod";

import { getClientIp, getUserAgent, handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requestLoginCode } from "@/modules/auth/login-code";
import { resolveLocale } from "@/modules/i18n/server";
import { assertTurnstile } from "@/modules/security/turnstile";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: z.string().email(),
  turnstileToken: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { email, turnstileToken } = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      bodySchema,
    );
    const ip = getClientIp(req);
    // 人机验证失败时直接抛错，不会进入验证码发送逻辑
    await assertTurnstile(turnstileToken, ip);
    await requestLoginCode(email, {
      ip,
      userAgent: getUserAgent(req),
      locale: await resolveLocale(),
    });
    return jsonOk({ sent: true });
  } catch (err) {
    return handleApiError(err);
  }
}
