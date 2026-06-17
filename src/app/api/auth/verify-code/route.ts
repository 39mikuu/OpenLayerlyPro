import { NextRequest } from "next/server";
import { z } from "zod";

import { getClientIp, getUserAgent, handleApiError, jsonOk } from "@/lib/api";
import { verifyLoginCode } from "@/modules/auth/login-code";
import { createSession, setSessionCookie } from "@/modules/auth/session";
import { resolveLocale } from "@/modules/i18n/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, "验证码为 6 位数字"),
});

export async function POST(req: NextRequest) {
  try {
    const { email, code } = bodySchema.parse(await req.json());
    const user = await verifyLoginCode(email, code, await resolveLocale());
    const { token, expiresAt } = await createSession(user.id, {
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });
    await setSessionCookie(token, expiresAt);
    return jsonOk({ id: user.id, email: user.email, role: user.role });
  } catch (err) {
    return handleApiError(err);
  }
}
