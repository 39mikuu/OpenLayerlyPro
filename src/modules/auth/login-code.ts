import { and, desc, eq, gt, isNull, lt, or, sql, type SQLWrapper } from "drizzle-orm";

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
  isLegacyLoginCode,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_PATTERN,
  normalizeEmail,
  normalizeLoginCode,
  validateLoginCodeChallenge,
} from "@/modules/auth/rate-limit-policy";
import { getSmtpConfig } from "@/modules/config";
import type { Locale } from "@/modules/i18n";
import { sendLoginCodeEmail } from "@/modules/mail";
import { classifyMailError, MailDeliveryError } from "@/modules/mail/delivery";
import { recordEvent } from "@/modules/system/events";
import { enqueueTask } from "@/modules/tasks/enqueue";
import { PermanentTaskError } from "@/modules/tasks/errors";
import { TaskOwnershipLostError } from "@/modules/tasks/ownership";
import { findOrCreateUserByEmail, touchLastLogin } from "@/modules/user";

const CODE_TTL_MINUTES = 10;
const LOGIN_CODE_HMAC_PURPOSE = "auth-login-code";
const LOGIN_CODE_CHALLENGE_HMAC_PURPOSE = "auth-login-code-challenge";

export type RequestLoginCodeResult = { suppressed: boolean; codeId?: string };

class LoginCodeAttemptsExceededError extends ApiError {
  readonly freshAttemptExhausted: boolean;

  constructor(freshAttemptExhausted: boolean) {
    super(429, "codeAttemptsExceeded");
    this.freshAttemptExhausted = freshAttemptExhausted;
  }
}

export type LoginCodeEmailTaskPayload = {
  version: 1;
  codeId: string;
  encryptedCode: string;
  locale?: Locale;
};

export type LoginCodeEmailTaskFence = {
  taskId: string;
  lockToken: string | null;
  assertTaskOwnership: () => Promise<void>;
};

export async function requestLoginCode(
  email: string,
  meta: {
    challenge: string;
    identity?: ClientRateLimitIdentity;
    ip?: string | null;
    userAgent?: string | null;
    locale?: Locale;
  },
): Promise<RequestLoginCodeResult> {
  const normalized = normalizeEmail(email);
  const challenge = validateLoginCodeChallenge(meta.challenge);
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
          and (
            ${loginCodes.challengeHash} is null
            or ${loginCodes.attemptCount} < ${LOGIN_CODE_MAX_ATTEMPTS}
          )
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
    const challengeHash = hmacLoginCodeChallenge(challenge);

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
        challengeHash,
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

export async function verifyLoginCode(
  email: string,
  code: string,
  challenge?: string,
  locale?: Locale,
): Promise<User> {
  const normalized = normalizeEmail(email);
  const normalizedCode = normalizeLoginCode(code);
  const db = getDb();

  const outcome = await db.transaction(
    async (
      tx,
    ): Promise<
      "correct" | "incorrect" | "attempts_exhausted_now" | "attempts_already_exhausted"
    > => {
      const [record] = await executeRows<{
        id: string;
        code_hash: string;
        challenge_hash: string | null;
        attempt_count: number;
      }>(
        tx,
        sql`
        select
          ${loginCodes.id} as id,
          ${loginCodes.codeHash} as code_hash,
          ${loginCodes.challengeHash} as challenge_hash,
          ${loginCodes.attemptCount} as attempt_count
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

      if (record.challenge_hash === null) {
        if (
          !isLegacyLoginCode(normalizedCode) ||
          !safeEqualHex(hmacLoginCode(normalizedCode), record.code_hash)
        ) {
          return "incorrect";
        }
      } else {
        const challengeMatches = Boolean(
          challenge && safeEqualHex(hmacLoginCodeChallenge(challenge), record.challenge_hash),
        );
        if (record.attempt_count >= LOGIN_CODE_MAX_ATTEMPTS) {
          return "attempts_already_exhausted";
        }
        const codeMatches =
          challengeMatches &&
          LOGIN_CODE_PATTERN.test(normalizedCode) &&
          safeEqualHex(hmacLoginCode(normalizedCode), record.code_hash);
        if (!challengeMatches || !codeMatches) {
          // Both new-protocol mismatch paths perform the same locked UPDATE
          // round trip. A challenge mismatch is a no-op and never compares the
          // candidate code; a matched challenge increments the durable cap.
          const increment = challengeMatches ? 1 : 0;
          const [attempt] = await executeRows<{ attempt_count: number }>(
            tx,
            sql`
            update ${loginCodes}
            set attempt_count = least(
              ${loginCodes.attemptCount} + ${increment},
              ${LOGIN_CODE_MAX_ATTEMPTS}
            )
            where ${loginCodes.id} = ${record.id}
            returning ${loginCodes.attemptCount} as attempt_count
          `,
          );
          if (!challengeMatches) return "incorrect";
          return (attempt?.attempt_count ?? LOGIN_CODE_MAX_ATTEMPTS) >= LOGIN_CODE_MAX_ATTEMPTS
            ? "attempts_exhausted_now"
            : "incorrect";
        }
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
    },
  );

  if (outcome === "incorrect") {
    throw new ApiError(400, "codeIncorrect");
  }
  if (outcome === "attempts_exhausted_now") {
    throw new LoginCodeAttemptsExceededError(true);
  }
  if (outcome === "attempts_already_exhausted") {
    throw new LoginCodeAttemptsExceededError(false);
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
        challengeHash: loginCodes.challengeHash,
        attemptCount: loginCodes.attemptCount,
      })
      .from(loginCodes)
      .where(eq(loginCodes.id, payload.codeId))
      .limit(1);

    if (
      !record ||
      record.usedAt ||
      record.expiresAt <= new Date() ||
      (record.challengeHash !== null && record.attemptCount >= LOGIN_CODE_MAX_ATTEMPTS)
    ) {
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
          or(
            isNull(loginCodes.challengeHash),
            lt(loginCodes.attemptCount, LOGIN_CODE_MAX_ATTEMPTS),
          ),
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
  await fence.assertTaskOwnership();
  try {
    await sendLoginCodeEmail(delivery.email, delivery.code, payload.locale, {
      assertTaskOwnership: fence.assertTaskOwnership,
    });
  } catch (error) {
    if (error instanceof TaskOwnershipLostError) throw error;
    const classification = classifyMailError(error);
    if (classification === "transient") {
      throw new MailDeliveryError("transient");
    }
    throw new PermanentTaskError(
      classification === "needs_operator"
        ? "SMTP unavailable for login code"
        : "Login code email delivery failed permanently",
      { classification },
    );
  }
  return undefined;
}

function hmacLoginCode(code: string): string {
  return hmacSha256WithPurpose(LOGIN_CODE_HMAC_PURPOSE, normalizeLoginCode(code));
}

function hmacLoginCodeChallenge(challenge: string): string {
  return hmacSha256WithPurpose(LOGIN_CODE_CHALLENGE_HMAC_PURPOSE, challenge);
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
