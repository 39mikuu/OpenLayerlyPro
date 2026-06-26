import { and, desc, eq, gt, isNull, sql, type SQLWrapper } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { loginCodes, tasks, type User } from "@/db/schema";
import { ApiError } from "@/lib/api";
import type { ClientRateLimitIdentity } from "@/lib/client-rate-limit";
import {
  decryptAuthTaskSecret,
  encryptAuthTaskSecret,
  generateLoginCode,
  hmacSha256WithPurpose,
  safeEqualHex,
} from "@/lib/crypto";
import { addMinutes } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import {
  getRequestCodeEmailIpRateLimit,
  normalizeEmail,
  normalizeLoginCode,
} from "@/modules/auth/rate-limit-policy";
import { getSmtpConfig } from "@/modules/config";
import type { Locale } from "@/modules/i18n";
import { sendLoginCodeEmail } from "@/modules/mail";
import { recordEvent } from "@/modules/system/events";
import { enqueueTask } from "@/modules/tasks";
import { PermanentTaskError } from "@/modules/tasks/errors";
import { findOrCreateUserByEmail, touchLastLogin } from "@/modules/user";

const CODE_TTL_MINUTES = 10;
const LOGIN_CODE_HMAC_PURPOSE = "auth-login-code";

export type RequestLoginCodeResult = { suppressed: boolean; codeId?: string };

export type LoginCodeEmailTaskPayload = {
  version: 1;
  codeId: string;
  encryptedCode: string;
  locale?: Locale;
};

export type LoginCodeEmailTaskFence = {
  taskId: string;
  lockToken: string | null;
};

export async function requestLoginCode(
  email: string,
  meta?: {
    identity?: ClientRateLimitIdentity;
    ip?: string | null;
    userAgent?: string | null;
    locale?: Locale;
  },
): Promise<RequestLoginCodeResult> {
  const normalized = normalizeEmail(email);
  const env = getEnv();
  const identity = meta?.identity ?? { kind: "unresolved" };

  const dedupeWindowMs = env.REQUEST_CODE_SEND_DEDUPE_SECONDS * 1000;
  const smtp = await getSmtpConfig();
  if (!smtp.configured) {
    throw new ApiError(500, "mailNotConfigured");
  }

  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${normalized}))`);

    const [active] = await executeRows<{ id: string; is_recent: boolean }>(
      tx,
      sql`
        select
          ${loginCodes.id} as id,
          (${loginCodes.createdAt} > now() - (${dedupeWindowMs} * interval '1 millisecond')) as is_recent
        from ${loginCodes}
        where ${loginCodes.email} = ${normalized}
          and ${loginCodes.usedAt} is null
          and ${loginCodes.expiresAt} > now()
        order by ${loginCodes.createdAt} desc
        limit 1
        for update
      `,
    );

    if (active) {
      const [deliveryTask] = await tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.dedupeKey, `auth-login-code-email:${active.id}`))
        .limit(1);

      if (!deliveryTask) {
        logger.warn("活跃登录验证码缺少持久投递任务；保守抑制重发", {
          emailDigest: hmacSha256WithPurpose("auth-log-email", normalized),
          codeId: active.id,
        });
        return { suppressed: true };
      }

      // Persistent delivery fence: while an existing task can still send or retry,
      // suppress replacement codes for at most the code's 10-minute TTL. This
      // preserves the invariant that an older code is never dispatched after a
      // newer code has been minted by the application.
      if (["pending", "processing", "failed"].includes(deliveryTask.status)) {
        return { suppressed: true };
      }
      if (active.is_recent) return { suppressed: true };
    }

    const code = generateLoginCode();
    const encryptedCode = encryptAuthTaskSecret(code);
    const codeHash = hmacLoginCode(code);

    if (identity.kind === "ip") {
      const emailIpLimit = getRequestCodeEmailIpRateLimit({
        normalizedEmail: normalized,
        ip: identity.value,
        env,
      });
      if (!rateLimit(emailIpLimit.key, emailIpLimit.max, emailIpLimit.windowMs)) {
        throw new ApiError(429, "requestRateLimited");
      }
    }

    const [inserted] = await tx
      .insert(loginCodes)
      .values({
        email: normalized,
        codeHash,
        expiresAt: addMinutes(new Date(), CODE_TTL_MINUTES),
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      })
      .returning({ id: loginCodes.id });

    await enqueueTask(tx, {
      kind: "auth.login_code_email",
      dedupeKey: `auth-login-code-email:${inserted.id}`,
      payload: {
        version: 1,
        codeId: inserted.id,
        encryptedCode,
        locale: meta?.locale,
      } satisfies LoginCodeEmailTaskPayload,
    });

    logger.info("登录验证码投递任务已排队", {
      emailDigest: hmacSha256WithPurpose("auth-log-email", normalized),
    });
    return { suppressed: false, codeId: inserted.id };
  });
}

export async function verifyLoginCode(email: string, code: string, locale?: Locale): Promise<User> {
  const normalized = normalizeEmail(email);
  const normalizedCode = normalizeLoginCode(code);
  const db = getDb();

  const outcome = await db.transaction(async (tx): Promise<"correct" | "incorrect"> => {
    const [record] = await executeRows<{
      id: string;
      code_hash: string;
    }>(
      tx,
      sql`
        select
          ${loginCodes.id} as id,
          ${loginCodes.codeHash} as code_hash
        from ${loginCodes}
        where ${loginCodes.email} = ${normalized}
          and ${loginCodes.usedAt} is null
          and ${loginCodes.expiresAt} > now()
        order by ${loginCodes.createdAt} desc
        limit 1
        for update
      `,
    );

    if (!record) {
      throw new ApiError(400, "codeExpired");
    }

    if (!safeEqualHex(hmacLoginCode(normalizedCode), record.code_hash)) {
      return "incorrect";
    }

    const used = await executeRows<{ id: string }>(
      tx,
      sql`
        update ${loginCodes}
        set used_at = now()
        where ${loginCodes.id} = ${record.id}
          and ${loginCodes.usedAt} is null
        returning ${loginCodes.id} as id
      `,
    );
    if (!used[0]) {
      throw new ApiError(400, "codeExpired");
    }
    return "correct";
  });

  if (outcome === "incorrect") {
    throw new ApiError(400, "codeIncorrect");
  }

  const user = await findOrCreateUserByEmail(normalized);
  await touchLastLogin(user.id, locale);
  await recordEvent("user_login", { userId: user.id });
  return user;
}

export async function deliverLoginCodeEmailTask(
  payload: LoginCodeEmailTaskPayload,
  fence: LoginCodeEmailTaskFence,
): Promise<string | undefined> {
  const lockToken = fence.lockToken;
  if (!lockToken) {
    throw new PermanentTaskError("Login code task claim is missing its lock token");
  }

  const delivery = await getDb().transaction(async (tx) => {
    const [claimedTask] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, fence.taskId),
          eq(tasks.kind, "auth.login_code_email"),
          eq(tasks.status, "processing"),
          eq(tasks.lockedBy, lockToken),
          gt(tasks.leaseUntil, sql<Date>`now()`),
        ),
      )
      .limit(1);

    if (!claimedTask) {
      return { note: "Login code task claim is stale; delivery skipped" } as const;
    }

    const [initial] = await tx
      .select({ email: loginCodes.email })
      .from(loginCodes)
      .where(eq(loginCodes.id, payload.codeId))
      .limit(1);

    if (!initial) {
      return { note: "Login code is no longer active; delivery skipped" } as const;
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${initial.email}))`);

    // Re-check the claim after waiting for the per-email lock. A reclaimed or
    // expired lease must become a successful no-op before decrypting or sending.
    const [stillClaimed] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, fence.taskId),
          eq(tasks.kind, "auth.login_code_email"),
          eq(tasks.status, "processing"),
          eq(tasks.lockedBy, lockToken),
          gt(tasks.leaseUntil, sql<Date>`now()`),
        ),
      )
      .limit(1);
    if (!stillClaimed) {
      return { note: "Login code task claim is stale; delivery skipped" } as const;
    }

    const [record] = await tx
      .select({
        id: loginCodes.id,
        email: loginCodes.email,
        expiresAt: loginCodes.expiresAt,
        usedAt: loginCodes.usedAt,
      })
      .from(loginCodes)
      .where(eq(loginCodes.id, payload.codeId))
      .limit(1);

    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      return { note: "Login code is no longer active; delivery skipped" } as const;
    }

    const [latest] = await tx
      .select({ id: loginCodes.id })
      .from(loginCodes)
      .where(
        and(
          eq(loginCodes.email, record.email),
          isNull(loginCodes.usedAt),
          gt(loginCodes.expiresAt, sql<Date>`now()`),
        ),
      )
      .orderBy(desc(loginCodes.createdAt))
      .limit(1);

    if (latest?.id !== payload.codeId) {
      return { note: "Login code was superseded; delivery skipped" } as const;
    }

    let code: string;
    try {
      code = decryptAuthTaskSecret(payload.encryptedCode);
    } catch {
      throw new PermanentTaskError("Login code task payload could not be decrypted");
    }

    return { email: record.email, code } as const;
  });

  if ("note" in delivery) return delivery.note;

  // SMTP and config lookup intentionally happen after Tx1 commits, so neither a
  // database connection nor the per-email advisory lock is held during network I/O.
  await sendLoginCodeEmail(delivery.email, delivery.code, payload.locale);
  return undefined;
}

function hmacLoginCode(code: string): string {
  return hmacSha256WithPurpose(LOGIN_CODE_HMAC_PURPOSE, normalizeLoginCode(code));
}

async function executeRows<T>(
  tx: Pick<DbClient, "execute">,
  query: SQLWrapper | string,
): Promise<T[]> {
  const result = await tx.execute(query);
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] }).rows;
  return (rows ?? []) as T[];
}
