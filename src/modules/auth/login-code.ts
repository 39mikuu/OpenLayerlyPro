import { sql, type SQLWrapper } from "drizzle-orm";

import { getDb } from "@/db";
import { loginCodes, type User } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { generateLoginCode, hmacSha256, safeEqualHex } from "@/lib/crypto";
import { addMinutes } from "@/lib/dates";
import { logger } from "@/lib/logger";
import { rateLimit, retryAfterSeconds } from "@/lib/rate-limit";
import { getSmtpConfig } from "@/modules/config";
import type { Locale } from "@/modules/i18n";
import { sendLoginCodeEmail } from "@/modules/mail";
import { recordEvent } from "@/modules/system/events";
import { findOrCreateUserByEmail, touchLastLogin } from "@/modules/user";

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const SEND_COOLDOWN_MS = 60 * 1000;
const HOURLY_WINDOW_MS = 60 * 60 * 1000;
const HOURLY_LIMIT = 5;

export async function requestLoginCode(
  email: string,
  meta?: { ip?: string | null; userAgent?: string | null; locale?: Locale },
): Promise<void> {
  const normalized = email.trim().toLowerCase();

  if (!rateLimit(`code-hour:${normalized}`, HOURLY_LIMIT, HOURLY_WINDOW_MS)) {
    throw new ApiError(429, "hourlyRateLimited");
  }
  if (!rateLimit(`code-cooldown:${normalized}`, 1, SEND_COOLDOWN_MS)) {
    const wait = retryAfterSeconds(`code-cooldown:${normalized}`, SEND_COOLDOWN_MS);
    throw new ApiError(429, "cooldownRateLimited", { seconds: wait });
  }
  if (meta?.ip && !rateLimit(`code-ip:${meta.ip}`, 20, HOURLY_WINDOW_MS)) {
    throw new ApiError(429, "requestRateLimited");
  }

  const code = generateLoginCode();
  await getDb()
    .insert(loginCodes)
    .values({
      email: normalized,
      codeHash: hmacSha256(code),
      expiresAt: addMinutes(new Date(), CODE_TTL_MINUTES),
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

  if ((await getSmtpConfig()).configured) {
    await sendLoginCodeEmail(normalized, code, meta?.locale);
  } else {
    // 开发模式下未配置 SMTP，仅在服务端日志输出提示（不输出验证码原文到结构化日志）
    if (process.env.NODE_ENV !== "production") {
      console.log(`[dev-only] 登录验证码 ${normalized}: ${code}`);
    } else {
      throw new ApiError(500, "mailNotConfigured");
    }
  }
  logger.info("登录验证码已发送", { email: normalized });
}

export async function verifyLoginCode(email: string, code: string, locale?: Locale): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const db = getDb();

  await db.transaction(async (tx) => {
    const attempts = await executeRows<{
      id: string;
      code_hash: string;
      attempt_count: number;
    }>(
      tx,
      sql`
        with candidate as (
          select id
          from ${loginCodes}
          where ${loginCodes.email} = ${normalized}
            and ${loginCodes.usedAt} is null
            and ${loginCodes.expiresAt} > now()
          order by ${loginCodes.createdAt} desc
          limit 1
          for update
        )
        update ${loginCodes}
        set ${loginCodes.attemptCount} = ${loginCodes.attemptCount} + 1
        where ${loginCodes.id} = (select id from candidate)
          and ${loginCodes.attemptCount} < ${MAX_ATTEMPTS}
        returning
          ${loginCodes.id} as id,
          ${loginCodes.codeHash} as code_hash,
          ${loginCodes.attemptCount} as attempt_count
      `,
    );
    const record = attempts[0];

    if (!record) {
      const active = await executeRows<{ attempt_count: number }>(
        tx,
        sql`
          select ${loginCodes.attemptCount} as attempt_count
          from ${loginCodes}
          where ${loginCodes.email} = ${normalized}
            and ${loginCodes.usedAt} is null
            and ${loginCodes.expiresAt} > now()
          order by ${loginCodes.createdAt} desc
          limit 1
        `,
      );
      if ((active[0]?.attempt_count ?? 0) >= MAX_ATTEMPTS) {
        throw new ApiError(429, "codeAttemptsExceeded");
      }
      throw new ApiError(400, "codeExpired");
    }

    if (!safeEqualHex(hmacSha256(code.trim()), record.code_hash)) {
      throw new ApiError(400, "codeIncorrect");
    }

    const used = await executeRows<{ id: string }>(
      tx,
      sql`
        update ${loginCodes}
        set ${loginCodes.usedAt} = now()
        where ${loginCodes.id} = ${record.id}
          and ${loginCodes.usedAt} is null
        returning ${loginCodes.id} as id
      `,
    );
    if (!used[0]) {
      throw new ApiError(400, "codeExpired");
    }
  });

  const user = await findOrCreateUserByEmail(normalized);
  await touchLastLogin(user.id, locale);
  await recordEvent("user_login", { userId: user.id });
  return user;
}

async function executeRows<T>(
  tx: { execute: (query: SQLWrapper | string) => unknown },
  query: SQLWrapper | string,
): Promise<T[]> {
  const result = await tx.execute(query);
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] }).rows;
  return (rows ?? []) as T[];
}
