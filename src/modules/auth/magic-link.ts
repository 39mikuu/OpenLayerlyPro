import { createHmac, randomBytes } from "crypto";
import { and, desc, eq, gt, isNull, sql, type SQLWrapper } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { magicLinkTokens, tasks, type User } from "@/db/schema";
import { ApiError } from "@/lib/api";
import type { ClientRateLimitIdentity } from "@/lib/client-rate-limit";
import {
  decryptAuthTaskSecret,
  encryptAuthTaskSecret,
  hmacSha256WithPurpose,
  safeEqualHex,
} from "@/lib/crypto";
import { addMinutes } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { getRequestCodeEmailIpRateLimit, normalizeEmail } from "@/modules/auth/rate-limit-policy";
import { getSmtpConfig } from "@/modules/config";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import type { Locale } from "@/modules/i18n";
import { sendMagicLinkEmail } from "@/modules/mail";
import { classifyMailError, MailDeliveryError } from "@/modules/mail/delivery";
import { type MagicLinkKey, tryGetMagicLinkKeys } from "@/modules/security/magic-link-key";
import { recordEvent } from "@/modules/system/events";
import { enqueueTask } from "@/modules/tasks";
import { PermanentTaskError } from "@/modules/tasks/errors";
import { findOrCreateUserByEmail, touchLastLogin } from "@/modules/user";

export const MAGIC_LINK_TTL_MINUTES = 15;
const TOKEN_PREFIX = "olp_mlk";
const TOKEN_VERSION = "v1";
const MAC_PURPOSE = "auth.magic_link:v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
export const MAGIC_LINK_REDIRECT_MAX_LENGTH = 512;
export const RAW_MAGIC_LINK_TOKEN_MAX_LENGTH = 256;

export type RequestMagicLinkResult = { suppressed: boolean; tokenId?: string };

export type MagicLinkEmailTaskPayload = {
  version: 1;
  tokenId: string;
  encryptedToken: string;
  locale?: Locale;
};

export type MagicLinkEmailTaskFence = {
  taskId: string;
  lockToken: string | null;
};

export type MagicLinkRejectionReason = "invalid" | "expired" | "replayed";

export type MagicLinkVerification =
  | { status: "valid"; tokenId: string }
  | { status: MagicLinkRejectionReason };

export type MagicLinkConsumption =
  | { status: "consumed"; user: User; redirectPath: string | null }
  | { status: MagicLinkRejectionReason };

export function isMagicLinkConfigured(): boolean {
  return tryGetMagicLinkKeys() !== null;
}

/**
 * 登录后跳转只允许站内相对路径:必须以单个 "/" 开头,拒绝 "//"、反斜杠与控制
 * 字符,query/fragment 一律剥离(结果 URL 不携带原始 query)。非法输入返回 null,
 * 调用方回落到默认跳转。
 */
export function normalizeMagicLinkRedirectPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  if (withoutQuery.length === 0 || withoutQuery.length > MAGIC_LINK_REDIRECT_MAX_LENGTH) {
    return null;
  }
  if (!withoutQuery.startsWith("/")) return null;
  if (withoutQuery.startsWith("//") || withoutQuery.startsWith("/\\")) return null;
  // 反斜杠会被浏览器当作 "/"，控制字符与空白可能被中间层重新解释，一律拒绝。
  if (/[\u0000-\u001f\u007f\\\s]/.test(withoutQuery)) return null;
  return withoutQuery;
}

function signToken(secretPart: string, key: MagicLinkKey): string {
  return createHmac("sha256", key.secret)
    .update(MAC_PURPOSE)
    .update("\0")
    .update(secretPart)
    .digest("hex");
}

export function generateMagicLinkToken(key: MagicLinkKey): {
  token: string;
  tokenHash: string;
  keyId: string;
} {
  const secretPart = randomBytes(32).toString("base64url");
  return {
    token: [TOKEN_PREFIX, TOKEN_VERSION, key.keyId, secretPart].join("."),
    tokenHash: signToken(secretPart, key),
    keyId: key.keyId,
  };
}

type ParsedMagicLinkToken = { keyId: string; secretPart: string };

export function parseMagicLinkToken(token: string): ParsedMagicLinkToken | null {
  if (token.length > RAW_MAGIC_LINK_TOKEN_MAX_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [prefix, version, keyId, secretPart] = parts;
  if (prefix !== TOKEN_PREFIX || version !== TOKEN_VERSION) return null;
  if (!KEY_ID_PATTERN.test(keyId) || !TOKEN_SECRET_PATTERN.test(secretPart)) return null;
  return { keyId, secretPart };
}

/**
 * 从 token 解析出可验证的 (keyId, hash)。keyId 不在 current/previous 中时返回
 * null(轮换已退役的 key 一律拒绝)。恒定时间比较由数据库等值查询前的 HMAC
 * 重算保证——攻击者拿不到 hash,只能盲猜 32 字节随机数。
 */
function resolveTokenHash(token: string): { keyId: string; tokenHash: string } | null {
  const parsed = parseMagicLinkToken(token);
  if (!parsed) return null;
  const keys = tryGetMagicLinkKeys();
  if (!keys) return null;
  const key = [keys.current, keys.previous].find((candidate) => candidate?.keyId === parsed.keyId);
  if (!key) return null;
  return { keyId: key.keyId, tokenHash: signToken(parsed.secretPart, key) };
}

export async function requestMagicLink(
  email: string,
  meta?: {
    identity?: ClientRateLimitIdentity;
    ip?: string | null;
    userAgent?: string | null;
    locale?: Locale;
    redirectPath?: string | null;
  },
): Promise<RequestMagicLinkResult> {
  const normalized = normalizeEmail(email);
  const env = getEnv();
  const identity = meta?.identity ?? { kind: "unresolved" };
  const keys = tryGetMagicLinkKeys();
  if (!keys) {
    throw new ApiError(500, "magicLinkNotConfigured");
  }

  const dedupeWindowMs = env.REQUEST_CODE_SEND_DEDUPE_SECONDS * 1000;
  const smtp = await getSmtpConfig();
  if (!smtp.configured) {
    throw new ApiError(500, "mailNotConfigured");
  }

  const result = await getDb().transaction(async (tx): Promise<RequestMagicLinkResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${normalized}))`);

    const [active] = await executeRows<{ id: string; is_recent: boolean }>(
      tx,
      sql`
        select
          ${magicLinkTokens.id} as id,
          (${magicLinkTokens.createdAt} > now() - (${dedupeWindowMs} * interval '1 millisecond')) as is_recent
        from ${magicLinkTokens}
        where ${magicLinkTokens.email} = ${normalized}
          and ${magicLinkTokens.consumedAt} is null
          and ${magicLinkTokens.expiresAt} > now()
        order by ${magicLinkTokens.createdAt} desc
        limit 1
        for update
      `,
    );

    if (active) {
      const [deliveryTask] = await tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.dedupeKey, `auth-magic-link-email:${active.id}`))
        .limit(1);

      if (!deliveryTask) {
        logger.warn("活跃 Magic Link 缺少持久投递任务；保守抑制重发", {
          emailDigest: hmacSha256WithPurpose("auth-log-email", normalized),
          tokenId: active.id,
        });
        return { suppressed: true };
      }

      // Persistent delivery fence: while an existing task can still send or retry,
      // suppress replacement links for at most the token TTL. This preserves the
      // invariant that an older link is never dispatched after a newer link has
      // been minted by the application.
      if (["pending", "processing", "failed"].includes(deliveryTask.status)) {
        return { suppressed: true };
      }
      if (active.is_recent) return { suppressed: true };
    }

    if (identity.kind === "ip") {
      // Shares the request-code (email, ip) budget on purpose: both flows spend
      // the same outbound auth-email quota for a target mailbox.
      const emailIpLimit = getRequestCodeEmailIpRateLimit({
        normalizedEmail: normalized,
        ip: identity.value,
        env,
      });
      if (!rateLimit(emailIpLimit.key, emailIpLimit.max, emailIpLimit.windowMs)) {
        throw new ApiError(429, "requestRateLimited");
      }
    }

    const generated = generateMagicLinkToken(keys.current);

    const [inserted] = await tx
      .insert(magicLinkTokens)
      .values({
        email: normalized,
        tokenHash: generated.tokenHash,
        keyId: generated.keyId,
        redirectPath: normalizeMagicLinkRedirectPath(meta?.redirectPath),
        expiresAt: addMinutes(new Date(), MAGIC_LINK_TTL_MINUTES),
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      })
      .returning({ id: magicLinkTokens.id });

    await enqueueTask(tx, {
      kind: "auth.magic_link_email",
      dedupeKey: `auth-magic-link-email:${inserted.id}`,
      payload: {
        version: 1,
        tokenId: inserted.id,
        encryptedToken: encryptAuthTaskSecret(generated.token),
        locale: meta?.locale,
      } satisfies MagicLinkEmailTaskPayload,
    });

    logger.info("Magic Link 投递任务已排队", {
      emailDigest: hmacSha256WithPurpose("auth-log-email", normalized),
    });
    return { suppressed: false, tokenId: inserted.id };
  });

  if (!result.suppressed && result.tokenId) {
    await recordEvent("magic_link_requested", {
      tokenId: result.tokenId,
      keyId: keys.current.keyId,
      emailDigest: hmacSha256WithPurpose("auth-log-email", normalized),
    });
  }
  return result;
}

export function buildMagicLinkConfirmUrl(token: string): string {
  return buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), `/login/magic/${token}`);
}

export async function deliverMagicLinkEmailTask(
  payload: MagicLinkEmailTaskPayload,
  fence: MagicLinkEmailTaskFence,
): Promise<string | undefined> {
  const lockToken = fence.lockToken;
  if (!lockToken) {
    throw new PermanentTaskError("Magic link task claim is missing its lock token");
  }

  const delivery = await getDb().transaction(async (tx) => {
    const claimFilter = and(
      eq(tasks.id, fence.taskId),
      eq(tasks.kind, "auth.magic_link_email"),
      eq(tasks.status, "processing"),
      eq(tasks.lockedBy, lockToken),
      gt(tasks.leaseUntil, sql<Date>`now()`),
    );
    const [claimedTask] = await tx.select({ id: tasks.id }).from(tasks).where(claimFilter).limit(1);
    if (!claimedTask) {
      return { note: "Magic link task claim is stale; delivery skipped" } as const;
    }

    const [initial] = await tx
      .select({ email: magicLinkTokens.email })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, payload.tokenId))
      .limit(1);

    if (!initial) {
      return { note: "Magic link is no longer active; delivery skipped" } as const;
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${initial.email}))`);

    // Re-check the claim after waiting for the per-email lock. A reclaimed or
    // expired lease must become a successful no-op before decrypting or sending.
    const [stillClaimed] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(claimFilter)
      .limit(1);
    if (!stillClaimed) {
      return { note: "Magic link task claim is stale; delivery skipped" } as const;
    }

    const [record] = await tx
      .select({
        id: magicLinkTokens.id,
        email: magicLinkTokens.email,
        expiresAt: magicLinkTokens.expiresAt,
        consumedAt: magicLinkTokens.consumedAt,
      })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, payload.tokenId))
      .limit(1);

    if (!record || record.consumedAt || record.expiresAt <= new Date()) {
      return { note: "Magic link is no longer active; delivery skipped" } as const;
    }

    const [latest] = await tx
      .select({ id: magicLinkTokens.id })
      .from(magicLinkTokens)
      .where(
        and(
          eq(magicLinkTokens.email, record.email),
          isNull(magicLinkTokens.consumedAt),
          gt(magicLinkTokens.expiresAt, sql<Date>`now()`),
        ),
      )
      .orderBy(desc(magicLinkTokens.createdAt))
      .limit(1);

    if (latest?.id !== payload.tokenId) {
      return { note: "Magic link was superseded; delivery skipped" } as const;
    }

    let token: string;
    try {
      token = decryptAuthTaskSecret(payload.encryptedToken);
    } catch {
      throw new PermanentTaskError("Magic link task payload could not be decrypted");
    }

    return { email: record.email, token } as const;
  });

  if ("note" in delivery) return delivery.note;

  // SMTP and config lookup intentionally happen after Tx1 commits, so neither a
  // database connection nor the per-email advisory lock is held during network I/O.
  try {
    await sendMagicLinkEmail(
      delivery.email,
      buildMagicLinkConfirmUrl(delivery.token),
      payload.locale,
    );
  } catch (error) {
    const classification = classifyMailError(error);
    if (classification === "transient") {
      throw new MailDeliveryError("transient");
    }
    throw new PermanentTaskError(
      classification === "needs_operator"
        ? "SMTP unavailable for magic link"
        : "Magic link email delivery failed permanently",
      { classification },
    );
  }
  await recordEvent("magic_link_sent", { tokenId: payload.tokenId });
  return undefined;
}

/**
 * GET 确认页专用:验证但绝不消费,也不写任何状态。邮件客户端 prefetch 只会
 * 走到这里,不会创建 session。
 */
export async function verifyMagicLinkToken(token: string): Promise<MagicLinkVerification> {
  const resolved = resolveTokenHash(token);
  if (!resolved) return { status: "invalid" };

  const [record] = await getDb()
    .select({
      id: magicLinkTokens.id,
      expiresAt: magicLinkTokens.expiresAt,
      consumedAt: magicLinkTokens.consumedAt,
      tokenHash: magicLinkTokens.tokenHash,
    })
    .from(magicLinkTokens)
    .where(
      and(
        eq(magicLinkTokens.tokenHash, resolved.tokenHash),
        eq(magicLinkTokens.keyId, resolved.keyId),
      ),
    )
    .limit(1);

  if (!record || !safeEqualHex(record.tokenHash, resolved.tokenHash)) {
    return { status: "invalid" };
  }
  if (record.consumedAt) return { status: "replayed" };
  if (record.expiresAt <= new Date()) return { status: "expired" };
  return { status: "valid", tokenId: record.id };
}

/**
 * 显式确认后的原子消费:仅 `hash + keyId + 未消费 + 未过期` 的第一笔条件更新
 * 获得登录资格,并发双击、重复点击或重放都只会得到 replayed/expired。
 */
export async function consumeMagicLinkToken(
  token: string,
  meta?: { locale?: Locale },
): Promise<MagicLinkConsumption> {
  const resolved = resolveTokenHash(token);
  if (!resolved) {
    await recordEvent("magic_link_rejected", { reason: "invalid" });
    return { status: "invalid" };
  }

  const db = getDb();
  const [consumed] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(magicLinkTokens.tokenHash, resolved.tokenHash),
        eq(magicLinkTokens.keyId, resolved.keyId),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, sql<Date>`now()`),
      ),
    )
    .returning({
      id: magicLinkTokens.id,
      email: magicLinkTokens.email,
      redirectPath: magicLinkTokens.redirectPath,
    });

  if (!consumed) {
    const [existing] = await db
      .select({
        id: magicLinkTokens.id,
        consumedAt: magicLinkTokens.consumedAt,
        expiresAt: magicLinkTokens.expiresAt,
      })
      .from(magicLinkTokens)
      .where(
        and(
          eq(magicLinkTokens.tokenHash, resolved.tokenHash),
          eq(magicLinkTokens.keyId, resolved.keyId),
        ),
      )
      .limit(1);
    const reason: MagicLinkRejectionReason = !existing
      ? "invalid"
      : existing.consumedAt
        ? "replayed"
        : "expired";
    await recordEvent("magic_link_rejected", {
      reason,
      ...(existing ? { tokenId: existing.id, keyId: resolved.keyId } : {}),
    });
    return { status: reason };
  }

  const user = await findOrCreateUserByEmail(consumed.email);
  await touchLastLogin(user.id, meta?.locale);
  await recordEvent("user_login", { userId: user.id });
  await recordEvent("magic_link_consumed", {
    tokenId: consumed.id,
    keyId: resolved.keyId,
    userId: user.id,
  });
  return {
    status: "consumed",
    user,
    redirectPath: normalizeMagicLinkRedirectPath(consumed.redirectPath),
  };
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
