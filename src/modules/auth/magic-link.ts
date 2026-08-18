import { createHmac, randomBytes, randomUUID } from "crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql, type SQLWrapper } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import {
  magicLinkMintLedger,
  magicLinkRequests,
  magicLinkTokens,
  tasks,
  type User,
  users,
} from "@/db/schema";
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
import {
  isExactLegacyMagicLinkDeliveryTask,
  isExactMagicLinkDeliveryV2Task,
  isExactMagicLinkIntakeTask,
} from "@/lib/magic-link-v2-task-graph";
import { rateLimit } from "@/lib/rate-limit";
import {
  clearMagicLinkStuckFenceAlert,
  recordMagicLinkDisposition,
  recordMagicLinkDispositionIfV2,
} from "@/modules/auth/magic-link-fence";
import { getRequestCodeEmailIpRateLimit, normalizeEmail } from "@/modules/auth/rate-limit-policy";
import { createSession } from "@/modules/auth/session";
import { getSmtpConfig } from "@/modules/config";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import { type Locale, SUPPORTED_LOCALES } from "@/modules/i18n";
import { sendMagicLinkEmail, sendMagicLinkEmailWithDeadline } from "@/modules/mail";
import { classifyMailError, MailDeliveryError } from "@/modules/mail/delivery";
import { type MagicLinkKey, tryGetMagicLinkKeys } from "@/modules/security/magic-link-key";
import { recordEvent } from "@/modules/system/events";
import { enqueueTask, enqueueTaskReturningId } from "@/modules/tasks";
import { PermanentTaskError } from "@/modules/tasks/errors";
import { TaskOwnershipLostError } from "@/modules/tasks/ownership";
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

export type MagicLinkDeliveryV2TaskPayload = {
  version: 1;
  deliveryProtocol: 2;
  tokenId: string;
  encryptedToken: string;
  locale?: Locale;
};

export type MagicLinkRequestTaskPayload = {
  version: 1;
  requestId: string;
};

export type MagicLinkEmailTaskFence = {
  taskId: string;
  lockToken: string | null;
  /** Required by the legacy delivery path at its last safe point before SMTP. */
  assertTaskOwnership?: () => Promise<void>;
};

export type MagicLinkRejectionReason = "invalid" | "expired" | "replayed";

export type MagicLinkVerification =
  | { status: "valid"; tokenId: string }
  | { status: MagicLinkRejectionReason };

export type MagicLinkConsumption =
  | {
      status: "consumed";
      user: User;
      redirectPath: string | null;
      session: { token: string; expiresAt: Date };
    }
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
  if (getEnv().MAGIC_LINK_INTAKE_ENABLED) {
    return requestMagicLinkViaIntake(email, meta);
  }
  return requestMagicLinkLegacy(email, meta);
}

/**
 * Phase-A compatibility path. It deliberately remains intact while
 * MAGIC_LINK_INTAKE_ENABLED=false so the schema migration can be deployed
 * before every old executable has been retired.
 */
async function requestMagicLinkLegacy(
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

    // Preserve token-before-user lock ordering with consumeMagicLinkToken so a
    // request cannot deadlock with a confirmation for the same mailbox.
    const [existingUser] = await executeRows<{ role: User["role"] }>(
      tx,
      sql`
        select ${users.role} as role
        from ${users}
        where ${users.email} = ${normalized}
        limit 1
        for update
      `,
    );
    if (existingUser?.role === "admin") {
      logger.info("Magic Link 请求已抑制", {
        emailDigest: hmacSha256WithPurpose("auth-log-email", normalized),
      });
      return { suppressed: true };
    }

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

    // Invalidate every still-active token for this mailbox before minting the
    // replacement. Delivery already skips superseded rows; consume/verify must
    // not keep accepting an older link after a newer one has been issued
    // (Codex P2 / WP1 single-live-link invariant).
    await tx
      .update(magicLinkTokens)
      .set({ expiresAt: sql`now()` })
      .where(
        and(
          eq(magicLinkTokens.email, normalized),
          isNull(magicLinkTokens.consumedAt),
          gt(magicLinkTokens.expiresAt, sql<Date>`now()`),
        ),
      );

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

/**
 * Protocol-v2 public path. It intentionally does not inspect users, tokens,
 * delivery tasks or the per-email send budget. Every source-gate-accepted
 * request takes the same request-row + intake-task write shape; role and mint
 * decisions happen later in the durable intake handler.
 */
async function requestMagicLinkViaIntake(
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
  const request = await getDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(magicLinkRequests)
      .values({
        email: normalized,
        locale: meta?.locale,
        redirectPath: normalizeMagicLinkRedirectPath(meta?.redirectPath),
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      })
      .returning({ id: magicLinkRequests.id });
    if (!created) throw new Error("Magic Link intake request was not created");

    await enqueueTask(tx, {
      kind: "auth.magic_link_request",
      dedupeKey: `auth-magic-link-request:${created.id}`,
      payload: { version: 1, requestId: created.id } satisfies MagicLinkRequestTaskPayload,
      queueClass: "auth_intake",
    });
    return created;
  });

  // This event is intentionally identical for every accepted request. In
  // particular, the resolver must not add a role/suppression-specific event.
  await recordEvent("magic_link_requested", {
    requestId: request.id,
    emailDigest: hmacSha256WithPurpose("auth-log-email", normalized),
  });
  return { suppressed: false };
}

export function buildMagicLinkConfirmUrl(token: string): string {
  return buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), `/login/magic/${token}`);
}

async function deliverLegacyMagicLinkEmailTask(
  payload: MagicLinkEmailTaskPayload,
  fence: MagicLinkEmailTaskFence,
): Promise<string | undefined> {
  const lockToken = fence.lockToken;
  if (!lockToken) {
    throw new PermanentTaskError("Magic link task claim is missing its lock token");
  }
  // Phase B must not deliver a residue created while the compatibility path was
  // active. The rollout still requires a verified legacy-residue drain before
  // this flag is enabled; this is a final fail-closed guard for an accidentally
  // claimed late row.
  if (getEnv().MAGIC_LINK_INTAKE_ENABLED) {
    return "Legacy Magic Link delivery was quarantined after protocol-v2 enablement";
  }

  const delivery = await getDb().transaction(async (tx) => {
    const claimFilter = and(
      eq(tasks.id, fence.taskId),
      eq(tasks.kind, "auth.magic_link_email"),
      eq(tasks.status, "processing"),
      eq(tasks.lockedBy, lockToken),
      gt(tasks.leaseUntil, sql<Date>`clock_timestamp()`),
    );
    const [claimedTask] = await tx.select().from(tasks).where(claimFilter).limit(1).for("update");
    if (!claimedTask) {
      return { note: "Magic link task claim is stale; delivery skipped" } as const;
    }
    if (!isExactLegacyMagicLinkDeliveryTask(claimedTask, payload.tokenId)) {
      throw new PermanentTaskError("Magic Link legacy task graph is invalid");
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

    // Re-check the fencing token and current task lease after waiting for the
    // per-email lock. A reclaimed or expired task must become a successful
    // no-op before decrypting or sending.
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

  if (!fence.assertTaskOwnership) {
    throw new PermanentTaskError("Magic link task ownership fence is missing");
  }

  // SMTP and config lookup intentionally happen after Tx1 commits, so neither a
  // database connection nor the per-email advisory lock is held during network I/O.
  try {
    await sendMagicLinkEmail(
      delivery.email,
      buildMagicLinkConfirmUrl(delivery.token),
      payload.locale,
      { assertTaskOwnership: fence.assertTaskOwnership },
    );
  } catch (error) {
    if (error instanceof TaskOwnershipLostError) throw error;
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
 * Resolve a role-blind public request under the durable task claim. The lock
 * order is task -> request -> email advisory lock -> tokens -> user. A
 * resolved request is an idempotent no-op on every later retry.
 */
export async function resolveMagicLinkRequestTask(
  payload: MagicLinkRequestTaskPayload,
  fence: MagicLinkEmailTaskFence,
): Promise<string | undefined> {
  const lockToken = fence.lockToken;
  if (!lockToken) {
    throw new PermanentTaskError("Magic Link intake task claim is missing its lock token");
  }

  return getDb().transaction(async (tx) => {
    const [claimed] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, fence.taskId))
      .limit(1)
      .for("update");
    if (
      !claimed ||
      claimed.kind !== "auth.magic_link_request" ||
      claimed.status !== "processing" ||
      claimed.lockedBy !== lockToken
    ) {
      return "Magic Link intake task claim is stale; resolution skipped";
    }
    if (!isExactMagicLinkIntakeTask(claimed, payload.requestId)) {
      throw new PermanentTaskError("Magic Link intake task graph is invalid");
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, fence.taskId))) {
      throw new Error("Magic Link intake task claim expired before resolution");
    }

    const [request] = await tx
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.id, payload.requestId))
      .limit(1)
      .for("update");
    if (!request) {
      // A resolved request may legitimately disappear after retention. A late
      // task must not recreate a token or turn this into a role-bearing alert.
      return "Magic Link intake request was retained no longer; resolution skipped";
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${request.email}))`);

    const [stillClaimed] = await tx
      .select({
        status: tasks.status,
        lockedBy: tasks.lockedBy,
        leaseUntil: tasks.leaseUntil,
        kind: tasks.kind,
      })
      .from(tasks)
      .where(eq(tasks.id, fence.taskId))
      .limit(1);
    if (
      !stillClaimed ||
      stillClaimed.kind !== "auth.magic_link_request" ||
      stillClaimed.status !== "processing" ||
      stillClaimed.lockedBy !== lockToken
    ) {
      return "Magic Link intake task claim is stale; resolution skipped";
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, fence.taskId))) {
      throw new Error("Magic Link intake task claim expired while waiting for the email lock");
    }
    if (request.resolvedAt) {
      return "Magic Link intake request was already resolved";
    }

    const [clock] = await executeRows<{ now: Date | string }>(tx, sql`select now() as now`);
    const now = clock ? parseMagicLinkDatabaseTimestamp(clock.now, "now") : new Date();
    const resolveWithoutMint = async (note: string) => {
      const [updated] = await tx
        .update(magicLinkRequests)
        .set({ resolvedAt: now })
        .where(and(eq(magicLinkRequests.id, request.id), isNull(magicLinkRequests.resolvedAt)))
        .returning({ id: magicLinkRequests.id });
      if (!updated) throw new Error("Magic Link intake request resolution lost its row lock");
      return note;
    };

    const candidates = await tx
      .select({
        id: magicLinkTokens.id,
        createdAt: magicLinkTokens.createdAt,
        consumedAt: magicLinkTokens.consumedAt,
        expiresAt: magicLinkTokens.expiresAt,
        deliveryState: magicLinkTokens.deliveryState,
        deliveredAt: magicLinkTokens.deliveredAt,
        deliveryReservationId: magicLinkTokens.deliveryReservationId,
        deliveryReservationUntil: magicLinkTokens.deliveryReservationUntil,
      })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, request.email))
      .orderBy(desc(magicLinkTokens.createdAt), desc(magicLinkTokens.id))
      .for("update");

    const [currentUser] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.email, request.email))
      .limit(1)
      .for("update");
    if (currentUser?.role === "admin") {
      return resolveWithoutMint("Magic Link intake resolved without delivery");
    }

    // Any pending candidate is a persistent fence. In particular, an expired
    // observation lease cannot make a non-null ownership generation safe to
    // overwrite or to ignore.
    if (candidates.some((candidate) => candidate.deliveryState === "pending")) {
      return resolveWithoutMint("Magic Link intake was deduplicated by a pending delivery");
    }

    const dedupeWindowMs = getEnv().REQUEST_CODE_SEND_DEDUPE_SECONDS * 1_000;
    if (
      candidates.some(
        (candidate) =>
          candidate.deliveryState === "active" &&
          candidate.deliveredAt !== null &&
          candidate.consumedAt === null &&
          candidate.expiresAt > now &&
          now.getTime() - candidate.deliveredAt.getTime() < dedupeWindowMs,
      )
    ) {
      return resolveWithoutMint("Magic Link intake was deduplicated by a delivered link");
    }

    if (claimed.attempts === 1) {
      const maxAgeMs = getEnv().MAGIC_LINK_REQUEST_MAX_AGE_MINUTES * 60_000;
      if (now.getTime() - request.createdAt.getTime() > maxAgeMs) {
        return resolveWithoutMint("Magic Link intake request exceeded its first-claim age");
      }
    }

    // A real send budget is intentionally evaluated only after the role-blind
    // public request has committed. It is trusted-IP scoped so an attacker
    // cannot cheaply consume another mailbox's useful capacity.
    if (request.ip) {
      const [budget] = await executeRows<{ count: number | string }>(
        tx,
        sql`
          select count(*)::int as count
          from magic_link_requests
          where email = ${request.email}
            and ip = ${request.ip}
            and minted_at is not null
            and minted_at > now() - (${getEnv().REQUEST_CODE_RATE_WINDOW_MS} * interval '1 millisecond')
        `,
      );
      if (Number(budget?.count ?? 0) >= getEnv().REQUEST_CODE_EMAIL_IP_RATE_MAX) {
        return resolveWithoutMint("Magic Link intake send budget is exhausted");
      }
    }

    const keys = tryGetMagicLinkKeys();
    if (!keys) {
      throw new PermanentTaskError("Magic Link keys are not configured for intake delivery");
    }
    const generated = generateMagicLinkToken(keys.current);
    const safeLocale =
      request.locale && (SUPPORTED_LOCALES as readonly string[]).includes(request.locale)
        ? (request.locale as Locale)
        : undefined;

    const [candidate] = await tx
      .insert(magicLinkTokens)
      .values({
        email: request.email,
        tokenHash: generated.tokenHash,
        keyId: generated.keyId,
        redirectPath: normalizeMagicLinkRedirectPath(request.redirectPath),
        // The legacy expiry predicate rejects a pending v2 row even if an old
        // executable is accidentally invoked. This is defense in depth only;
        // the deployment gate remains mandatory.
        expiresAt: new Date(0),
        deliveryState: "pending",
        deliveredAt: null,
        deliveryReservationId: null,
        deliveryReservationUntil: null,
        ip: request.ip,
        userAgent: request.userAgent,
      })
      .returning({ id: magicLinkTokens.id });
    if (!candidate) throw new Error("Magic Link pending candidate was not created");

    const deliveryTaskId = await enqueueTaskReturningId(tx, {
      kind: "auth.magic_link_email",
      dedupeKey: `auth-magic-link-email:${candidate.id}`,
      payload: {
        version: 1,
        deliveryProtocol: 2,
        tokenId: candidate.id,
        encryptedToken: encryptAuthTaskSecret(generated.token),
        ...(safeLocale ? { locale: safeLocale } : {}),
      } satisfies MagicLinkDeliveryV2TaskPayload,
      queueClass: "auth_delivery_v2",
    });

    const [updatedRequest] = await tx
      .update(magicLinkRequests)
      .set({
        resolvedAt: now,
        mintedAt: now,
        mintedTokenId: candidate.id,
      })
      .where(and(eq(magicLinkRequests.id, request.id), isNull(magicLinkRequests.resolvedAt)))
      .returning({
        id: magicLinkRequests.id,
        mintedAt: magicLinkRequests.mintedAt,
        mintedTokenId: magicLinkRequests.mintedTokenId,
      });
    if (
      !updatedRequest ||
      !updatedRequest.mintedAt ||
      updatedRequest.mintedTokenId !== candidate.id
    ) {
      throw new Error("Magic Link intake request ledger update failed");
    }

    await tx.insert(magicLinkMintLedger).values({
      requestId: request.id,
      mintedTokenId: candidate.id,
      deliveryTaskId,
      mintedAt: updatedRequest.mintedAt,
    });
    return "Magic Link v2 delivery task was minted";
  });
}

async function clearMagicLinkReservationAfterClosedSocket(input: {
  taskId: string;
  lockToken: string;
  candidateId: string;
  reservationId: string;
}): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .for("update");
    if (
      !task ||
      task.kind !== "auth.magic_link_email" ||
      task.status !== "processing" ||
      task.lockedBy !== input.lockToken
    ) {
      return false;
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, input.taskId))) return false;
    if (!isExactMagicLinkDeliveryV2Task(task, input.candidateId)) return false;

    const [candidate] = await tx
      .select({
        id: magicLinkTokens.id,
        deliveryState: magicLinkTokens.deliveryState,
        deliveryReservationId: magicLinkTokens.deliveryReservationId,
      })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, input.candidateId))
      .limit(1)
      .for("update");
    if (
      !candidate ||
      candidate.deliveryState !== "pending" ||
      candidate.deliveryReservationId !== input.reservationId
    ) {
      return false;
    }

    const [cleared] = await tx
      .update(magicLinkTokens)
      .set({
        deliveryReservationId: null,
        deliveryReservationUntil: null,
      })
      .where(
        and(
          eq(magicLinkTokens.id, input.candidateId),
          eq(magicLinkTokens.deliveryState, "pending"),
          eq(magicLinkTokens.deliveryReservationId, input.reservationId),
        ),
      )
      .returning({ id: magicLinkTokens.id });
    if (cleared) {
      await clearMagicLinkStuckFenceAlert(tx, {
        candidateId: input.candidateId,
        reservationId: input.reservationId,
      });
    }
    return Boolean(cleared);
  });
}

/**
 * Extend only this invocation's observation lease while SMTP I/O is still
 * alive. Ownership comes from the UUID generation plus a current task claim,
 * never from matching a reservation timestamp or merely observing that its
 * prior observation lease passed.
 */
async function renewMagicLinkDeliveryReservation(input: {
  taskId: string;
  lockToken: string;
  candidateId: string;
  reservationId: string;
  email: string;
}): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .for("update");
    if (
      !task ||
      task.kind !== "auth.magic_link_email" ||
      task.status !== "processing" ||
      task.lockedBy !== input.lockToken
    ) {
      return false;
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, input.taskId))) return false;
    if (!isExactMagicLinkDeliveryV2Task(task, input.candidateId)) return false;

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.email}))`);
    const [stillClaimed] = await tx
      .select({
        kind: tasks.kind,
        status: tasks.status,
        lockedBy: tasks.lockedBy,
        leaseUntil: tasks.leaseUntil,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    if (
      !stillClaimed ||
      stillClaimed.kind !== "auth.magic_link_email" ||
      stillClaimed.status !== "processing" ||
      stillClaimed.lockedBy !== input.lockToken
    ) {
      return false;
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, input.taskId))) return false;

    const [candidate] = await tx
      .select({
        id: magicLinkTokens.id,
        deliveryState: magicLinkTokens.deliveryState,
        deliveryReservationId: magicLinkTokens.deliveryReservationId,
      })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, input.candidateId))
      .limit(1)
      .for("update");
    if (
      !candidate ||
      candidate.deliveryState !== "pending" ||
      candidate.deliveryReservationId !== input.reservationId
    ) {
      return false;
    }

    const [ledger] = await tx
      .select({ deliveryTaskId: magicLinkMintLedger.deliveryTaskId })
      .from(magicLinkMintLedger)
      .where(eq(magicLinkMintLedger.mintedTokenId, candidate.id))
      .limit(1)
      .for("update");
    if (ledger?.deliveryTaskId !== input.taskId) return false;

    const [renewed] = await tx
      .update(magicLinkTokens)
      .set({
        deliveryReservationUntil: sql`now() + (${getEnv().MAGIC_LINK_DELIVERY_RESERVATION_SECONDS} * interval '1 second')`,
      })
      .where(
        and(
          eq(magicLinkTokens.id, input.candidateId),
          eq(magicLinkTokens.deliveryState, "pending"),
          eq(magicLinkTokens.deliveryReservationId, input.reservationId),
        ),
      )
      .returning({ id: magicLinkTokens.id });
    return Boolean(renewed);
  });
}

async function reserveMagicLinkDeliveryV2(
  payload: MagicLinkDeliveryV2TaskPayload,
  fence: MagicLinkEmailTaskFence,
  email: string,
): Promise<{ note: string } | { reservationId: string }> {
  const lockToken = fence.lockToken;
  if (!lockToken)
    throw new PermanentTaskError("Magic Link delivery task claim is missing its lock token");

  return getDb().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, fence.taskId))
      .limit(1)
      .for("update");
    if (
      !task ||
      task.kind !== "auth.magic_link_email" ||
      task.status !== "processing" ||
      task.lockedBy !== lockToken
    ) {
      return { note: "Magic Link delivery task claim is stale; delivery skipped" };
    }
    if (!isExactMagicLinkDeliveryV2Task(task, payload.tokenId)) {
      throw new PermanentTaskError("Magic Link delivery task graph is invalid");
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, fence.taskId))) {
      throw new Error("Magic Link delivery task claim expired before reservation");
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${email}))`);

    const [stillClaimed] = await tx
      .select({
        status: tasks.status,
        lockedBy: tasks.lockedBy,
        leaseUntil: tasks.leaseUntil,
        kind: tasks.kind,
      })
      .from(tasks)
      .where(eq(tasks.id, fence.taskId))
      .limit(1);
    if (
      !stillClaimed ||
      stillClaimed.kind !== "auth.magic_link_email" ||
      stillClaimed.status !== "processing" ||
      stillClaimed.lockedBy !== lockToken
    ) {
      return { note: "Magic Link delivery task claim is stale; delivery skipped" };
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, fence.taskId))) {
      throw new Error("Magic Link delivery task claim expired while waiting for the email lock");
    }

    const [candidate] = await tx
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, payload.tokenId))
      .limit(1)
      .for("update");
    if (!candidate || candidate.email !== email) {
      throw new PermanentTaskError("Magic Link v2 payload no longer matches its candidate");
    }
    if (
      candidate.deliveryState === "active" &&
      candidate.deliveredAt !== null &&
      candidate.deliveryReservationId === null &&
      candidate.deliveryReservationUntil === null
    ) {
      return { note: "Magic Link candidate was already activated" };
    }
    if (
      candidate.deliveryState === "superseded" ||
      candidate.deliveryState === "cancelled" ||
      candidate.consumedAt !== null
    ) {
      return { note: "Magic Link candidate is terminal; delivery skipped" };
    }
    if (
      candidate.deliveryState !== "pending" ||
      candidate.deliveryReservationId !== null ||
      candidate.deliveryReservationUntil !== null
    ) {
      // A non-null generation is a fail-closed promotion fence even when the
      // task was reclaimed or its observation lease elapsed.
      throw new PermanentTaskError("Magic Link candidate has a non-null delivery reservation");
    }

    const [ledger] = await tx
      .select({ deliveryTaskId: magicLinkMintLedger.deliveryTaskId })
      .from(magicLinkMintLedger)
      .where(eq(magicLinkMintLedger.mintedTokenId, candidate.id))
      .limit(1)
      .for("update");
    if (ledger?.deliveryTaskId !== fence.taskId) {
      throw new PermanentTaskError("Magic Link candidate/task ledger linkage is invalid");
    }

    const [currentUser] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
      .for("update");
    if (currentUser?.role === "admin") {
      const [cancelled] = await tx
        .update(magicLinkTokens)
        .set({
          deliveryState: "cancelled",
          expiresAt: sql`now()`,
          deliveryReservationId: null,
          deliveryReservationUntil: null,
        })
        .where(
          and(eq(magicLinkTokens.id, candidate.id), eq(magicLinkTokens.deliveryState, "pending")),
        )
        .returning({ id: magicLinkTokens.id });
      if (!cancelled)
        throw new PermanentTaskError("Magic Link admin cancellation lost its candidate");
      await recordMagicLinkDisposition(tx, {
        candidateId: candidate.id,
        finalState: "cancelled",
        reservationId: null,
      });
      await clearMagicLinkStuckFenceAlert(tx, { candidateId: candidate.id });
      return { note: "Magic Link delivery became an administrator boundary no-op" };
    }

    const reservationId = randomUUID();
    const [reserved] = await tx
      .update(magicLinkTokens)
      .set({
        deliveryReservationId: reservationId,
        deliveryReservationUntil: sql`now() + (${getEnv().MAGIC_LINK_DELIVERY_RESERVATION_SECONDS} * interval '1 second')`,
      })
      .where(
        and(
          eq(magicLinkTokens.id, candidate.id),
          eq(magicLinkTokens.deliveryState, "pending"),
          isNull(magicLinkTokens.deliveryReservationId),
          isNull(magicLinkTokens.deliveryReservationUntil),
        ),
      )
      .returning({ id: magicLinkTokens.id });
    if (!reserved) throw new PermanentTaskError("Magic Link delivery reservation was not acquired");
    return { reservationId };
  });
}

function isNewerMagicLinkCandidate(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): boolean {
  return (
    left.createdAt.getTime() > right.createdAt.getTime() ||
    (left.createdAt.getTime() === right.createdAt.getTime() && left.id > right.id)
  );
}

async function activateMagicLinkDeliveryV2(input: {
  payload: MagicLinkDeliveryV2TaskPayload;
  fence: MagicLinkEmailTaskFence;
  email: string;
  reservationId: string;
}): Promise<string | undefined> {
  const lockToken = input.fence.lockToken;
  if (!lockToken)
    throw new PermanentTaskError("Magic Link delivery task claim is missing its lock token");

  return getDb().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.fence.taskId))
      .limit(1)
      .for("update");
    if (
      !task ||
      task.kind !== "auth.magic_link_email" ||
      task.status !== "processing" ||
      task.lockedBy !== lockToken
    ) {
      return "Magic Link delivery task claim is stale after SMTP";
    }
    if (!isExactMagicLinkDeliveryV2Task(task, input.payload.tokenId)) {
      throw new PermanentTaskError("Magic Link delivery task graph is invalid after SMTP");
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, input.fence.taskId))) {
      throw new Error("Magic Link delivery task claim expired before activation");
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.email}))`);

    const [stillClaimed] = await tx
      .select({
        kind: tasks.kind,
        status: tasks.status,
        lockedBy: tasks.lockedBy,
        leaseUntil: tasks.leaseUntil,
      })
      .from(tasks)
      .where(eq(tasks.id, input.fence.taskId))
      .limit(1);
    if (
      !stillClaimed ||
      stillClaimed.kind !== "auth.magic_link_email" ||
      stillClaimed.status !== "processing" ||
      stillClaimed.lockedBy !== lockToken
    ) {
      return "Magic Link delivery task claim became stale after SMTP";
    }
    if (!(await hasCurrentMagicLinkTaskLease(tx, input.fence.taskId))) {
      throw new Error("Magic Link delivery task claim expired while waiting for activation lock");
    }

    const [candidate] = await tx
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, input.payload.tokenId))
      .limit(1)
      .for("update");
    if (!candidate || candidate.email !== input.email) {
      throw new PermanentTaskError("Magic Link candidate disappeared before activation");
    }
    if (
      candidate.deliveryState === "active" &&
      candidate.deliveredAt !== null &&
      candidate.deliveryReservationId === null &&
      candidate.deliveryReservationUntil === null
    ) {
      return "Magic Link candidate was already activated";
    }
    if (
      candidate.deliveryState === "superseded" ||
      candidate.deliveryState === "cancelled" ||
      candidate.consumedAt !== null
    ) {
      return "Magic Link candidate is terminal after SMTP";
    }
    if (
      candidate.deliveryState !== "pending" ||
      candidate.deliveryReservationId !== input.reservationId
    ) {
      throw new PermanentTaskError("Magic Link delivery ownership generation was lost");
    }

    const [ledger] = await tx
      .select({ deliveryTaskId: magicLinkMintLedger.deliveryTaskId })
      .from(magicLinkMintLedger)
      .where(eq(magicLinkMintLedger.mintedTokenId, candidate.id))
      .limit(1)
      .for("update");
    if (ledger?.deliveryTaskId !== input.fence.taskId) {
      throw new PermanentTaskError(
        "Magic Link candidate/task ledger linkage changed before activation",
      );
    }

    const allTokens = await tx
      .select({
        id: magicLinkTokens.id,
        createdAt: magicLinkTokens.createdAt,
        consumedAt: magicLinkTokens.consumedAt,
        expiresAt: magicLinkTokens.expiresAt,
        deliveryState: magicLinkTokens.deliveryState,
      })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, input.email))
      .orderBy(desc(magicLinkTokens.createdAt), desc(magicLinkTokens.id))
      .for("update");
    const [currentUser] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)
      .for("update");
    const now = new Date();

    const cancelCandidate = async (note: string) => {
      const [cancelled] = await tx
        .update(magicLinkTokens)
        .set({
          deliveryState: "cancelled",
          expiresAt: now,
          deliveryReservationId: null,
          deliveryReservationUntil: null,
        })
        .where(
          and(
            eq(magicLinkTokens.id, candidate.id),
            eq(magicLinkTokens.deliveryState, "pending"),
            eq(magicLinkTokens.deliveryReservationId, input.reservationId),
          ),
        )
        .returning({ id: magicLinkTokens.id });
      if (!cancelled)
        throw new PermanentTaskError("Magic Link candidate cancellation lost ownership");
      await recordMagicLinkDisposition(tx, {
        candidateId: candidate.id,
        finalState: "cancelled",
        reservationId: input.reservationId,
      });
      await clearMagicLinkStuckFenceAlert(tx, {
        candidateId: candidate.id,
        reservationId: input.reservationId,
      });
      return note;
    };

    if (currentUser?.role === "admin") {
      return cancelCandidate("Magic Link delivery became an administrator boundary no-op");
    }

    const newerEligible = allTokens.find(
      (row) =>
        row.id !== candidate.id &&
        row.consumedAt === null &&
        (row.deliveryState === "pending" || row.deliveryState === "active") &&
        isNewerMagicLinkCandidate(row, candidate),
    );
    if (newerEligible) {
      const [superseded] = await tx
        .update(magicLinkTokens)
        .set({
          deliveryState: "superseded",
          supersededAt: now,
          expiresAt: now,
          deliveryReservationId: null,
          deliveryReservationUntil: null,
        })
        .where(
          and(
            eq(magicLinkTokens.id, candidate.id),
            eq(magicLinkTokens.deliveryState, "pending"),
            eq(magicLinkTokens.deliveryReservationId, input.reservationId),
          ),
        )
        .returning({ id: magicLinkTokens.id });
      if (!superseded)
        throw new PermanentTaskError("Magic Link candidate supersession lost ownership");
      await recordMagicLinkDisposition(tx, {
        candidateId: candidate.id,
        finalState: "superseded",
        reservationId: input.reservationId,
      });
      await clearMagicLinkStuckFenceAlert(tx, {
        candidateId: candidate.id,
        reservationId: input.reservationId,
      });
      return "Magic Link candidate was superseded by a newer eligible candidate";
    }

    if (
      allTokens.some(
        (row) =>
          row.id !== candidate.id &&
          row.deliveryState === "active" &&
          row.consumedAt !== null &&
          row.consumedAt >= candidate.createdAt,
      )
    ) {
      return cancelCandidate("An older Magic Link was consumed during delivery");
    }

    const supersededIds = allTokens
      .filter(
        (row) =>
          row.id !== candidate.id &&
          row.deliveryState === "active" &&
          row.consumedAt === null &&
          row.expiresAt > now &&
          isNewerMagicLinkCandidate(candidate, row),
      )
      .map((row) => row.id);
    if (supersededIds.length > 0) {
      await tx
        .update(magicLinkTokens)
        .set({ deliveryState: "superseded", supersededAt: now, expiresAt: now })
        .where(inArray(magicLinkTokens.id, supersededIds));
      for (const candidateId of supersededIds) {
        await recordMagicLinkDispositionIfV2(tx, {
          candidateId,
          finalState: "superseded",
          reservationId: null,
        });
      }
    }

    const [activated] = await tx
      .update(magicLinkTokens)
      .set({
        deliveryState: "active",
        deliveredAt: now,
        expiresAt: addMinutes(now, MAGIC_LINK_TTL_MINUTES),
        deliveryReservationId: null,
        deliveryReservationUntil: null,
      })
      .where(
        and(
          eq(magicLinkTokens.id, candidate.id),
          eq(magicLinkTokens.deliveryState, "pending"),
          eq(magicLinkTokens.deliveryReservationId, input.reservationId),
        ),
      )
      .returning({ id: magicLinkTokens.id });
    if (!activated) throw new PermanentTaskError("Magic Link candidate activation lost ownership");
    await clearMagicLinkStuckFenceAlert(tx, {
      candidateId: candidate.id,
      reservationId: input.reservationId,
    });
    return undefined;
  });
}

async function deliverMagicLinkEmailTaskV2(
  payload: MagicLinkDeliveryV2TaskPayload,
  fence: MagicLinkEmailTaskFence,
): Promise<string | undefined> {
  const lockToken = fence.lockToken;
  if (!lockToken)
    throw new PermanentTaskError("Magic Link delivery task claim is missing its lock token");

  // This non-authoritative read exists only to select the per-email advisory
  // lock. Transaction A rereads and verifies the candidate under that lock.
  const [preloaded] = await getDb()
    .select({ email: magicLinkTokens.email })
    .from(magicLinkTokens)
    .where(eq(magicLinkTokens.id, payload.tokenId))
    .limit(1);
  if (!preloaded) return "Magic Link candidate is absent; delivery skipped";

  const reserved = await reserveMagicLinkDeliveryV2(payload, fence, preloaded.email);
  if ("note" in reserved) return reserved.note;

  let token: string;
  try {
    token = decryptAuthTaskSecret(payload.encryptedToken);
  } catch {
    const cleared = await clearMagicLinkReservationAfterClosedSocket({
      taskId: fence.taskId,
      lockToken,
      candidateId: payload.tokenId,
      reservationId: reserved.reservationId,
    });
    if (!cleared) {
      throw new PermanentTaskError(
        "Magic Link reservation was retained after payload decryption failure",
      );
    }
    throw new PermanentTaskError("Magic Link v2 task payload could not be decrypted");
  }

  const sendAbort = new AbortController();
  let stopReservationRenewal = false;
  let reservationOwnershipLost = false;
  const renewalIntervalMs = Math.max(
    1_000,
    Math.min(10_000, Math.floor((getEnv().MAGIC_LINK_DELIVERY_RESERVATION_SECONDS * 1_000) / 3)),
  );
  const renewalTimer = setInterval(() => {
    if (stopReservationRenewal || reservationOwnershipLost) return;
    void renewMagicLinkDeliveryReservation({
      taskId: fence.taskId,
      lockToken,
      candidateId: payload.tokenId,
      reservationId: reserved.reservationId,
      email: preloaded.email,
    })
      .then((renewed) => {
        if (renewed || stopReservationRenewal) return;
        reservationOwnershipLost = true;
        sendAbort.abort();
      })
      .catch(() => {
        // A renewal failure cannot be treated as proof of ownership loss, but
        // it does require stopping the live SMTP invocation. Transaction B or
        // the exact socket-closed clear path will revalidate every fence.
        sendAbort.abort();
      });
  }, renewalIntervalMs);
  renewalTimer.unref();

  try {
    await sendMagicLinkEmailWithDeadline(
      preloaded.email,
      buildMagicLinkConfirmUrl(token),
      payload.locale,
      getEnv().MAGIC_LINK_DELIVERY_MAX_TOTAL_SECONDS,
      { signal: sendAbort.signal },
    );
  } catch (error) {
    stopReservationRenewal = true;
    clearInterval(renewalTimer);
    if (reservationOwnershipLost) {
      throw new PermanentTaskError("Magic Link delivery ownership was lost during SMTP");
    }
    const cleared = await clearMagicLinkReservationAfterClosedSocket({
      taskId: fence.taskId,
      lockToken,
      candidateId: payload.tokenId,
      reservationId: reserved.reservationId,
    });
    if (!cleared) {
      throw new PermanentTaskError(
        "Magic Link reservation could not be safely released after SMTP failure",
      );
    }
    const classification = classifyMailError(error);
    if (classification === "transient") throw new MailDeliveryError("transient");
    throw new PermanentTaskError(
      classification === "needs_operator"
        ? "SMTP unavailable for Magic Link"
        : "Magic Link email delivery failed permanently",
      { classification },
    );
  }
  stopReservationRenewal = true;
  clearInterval(renewalTimer);
  if (reservationOwnershipLost) {
    throw new PermanentTaskError("Magic Link delivery ownership was lost after SMTP");
  }

  try {
    const note = await activateMagicLinkDeliveryV2({
      payload,
      fence,
      email: preloaded.email,
      reservationId: reserved.reservationId,
    });
    if (note) return note;
  } catch {
    // SMTP has returned and the independent transport is closed. A retry may
    // only happen after this exact generation is cleared under the current
    // task claim; otherwise retain the fence and dead-letter safely.
    const cleared = await clearMagicLinkReservationAfterClosedSocket({
      taskId: fence.taskId,
      lockToken,
      candidateId: payload.tokenId,
      reservationId: reserved.reservationId,
    });
    if (!cleared) {
      throw new PermanentTaskError(
        "Magic Link reservation was retained after post-SMTP activation failure",
      );
    }
    throw new MailDeliveryError("transient");
  }

  await recordEvent("magic_link_sent", { tokenId: payload.tokenId });
  return undefined;
}

export async function deliverMagicLinkEmailTask(
  payload: MagicLinkEmailTaskPayload | MagicLinkDeliveryV2TaskPayload,
  fence: MagicLinkEmailTaskFence,
): Promise<string | undefined> {
  return "deliveryProtocol" in payload && payload.deliveryProtocol === 2
    ? deliverMagicLinkEmailTaskV2(payload, fence)
    : deliverLegacyMagicLinkEmailTask(payload, fence);
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
      deliveryState: magicLinkTokens.deliveryState,
      deliveredAt: magicLinkTokens.deliveredAt,
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
  if (record.deliveryState !== "active" || !record.deliveredAt) return { status: "invalid" };
  if (record.expiresAt <= new Date()) return { status: "expired" };
  return { status: "valid", tokenId: record.id };
}

/**
 * 显式确认后的原子消费:仅 `hash + keyId + 未消费 + 未过期` 的第一笔条件更新
 * 获得登录资格,并发双击、重复点击或重放都只会得到 replayed/expired。
 */
export async function consumeMagicLinkToken(
  token: string,
  meta?: { locale?: Locale; ip?: string | null; userAgent?: string | null },
): Promise<MagicLinkConsumption> {
  const resolved = resolveTokenHash(token);
  if (!resolved) {
    await recordEvent("magic_link_rejected", { reason: "invalid" });
    return { status: "invalid" };
  }

  const outcome = await getDb().transaction(async (tx) => {
    const [consumed] = await tx
      .update(magicLinkTokens)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(magicLinkTokens.tokenHash, resolved.tokenHash),
          eq(magicLinkTokens.keyId, resolved.keyId),
          isNull(magicLinkTokens.consumedAt),
          eq(magicLinkTokens.deliveryState, "active"),
          isNotNull(magicLinkTokens.deliveredAt),
          gt(magicLinkTokens.expiresAt, sql<Date>`now()`),
        ),
      )
      .returning({
        id: magicLinkTokens.id,
        email: magicLinkTokens.email,
        redirectPath: magicLinkTokens.redirectPath,
      });

    if (!consumed) {
      const [existing] = await tx
        .select({
          id: magicLinkTokens.id,
          consumedAt: magicLinkTokens.consumedAt,
          expiresAt: magicLinkTokens.expiresAt,
          deliveryState: magicLinkTokens.deliveryState,
          deliveredAt: magicLinkTokens.deliveredAt,
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
          : existing.deliveryState !== "active" || !existing.deliveredAt
            ? "invalid"
            : "expired";
      return {
        result: { status: reason } satisfies MagicLinkConsumption,
        rejectionEvent: {
          reason,
          ...(existing ? { tokenId: existing.id, keyId: resolved.keyId } : {}),
        },
      };
    }

    const [lockedUser] = await executeRows<{ id: string; role: User["role"] }>(
      tx,
      sql`
        select ${users.id} as id, ${users.role} as role
        from ${users}
        where ${users.email} = ${consumed.email}
        limit 1
        for no key update
      `,
    );
    if (lockedUser?.role === "admin") {
      return {
        result: { status: "invalid" } satisfies MagicLinkConsumption,
        rejectionEvent: {
          reason: "invalid" as const,
          boundary: "admin",
          tokenId: consumed.id,
          keyId: resolved.keyId,
          userId: lockedUser.id,
        },
      };
    }

    const user = await findOrCreateUserByEmail(consumed.email, tx);
    // The conflict path in findOrCreateUserByEmail re-selects without a row
    // lock. Lock the final row before deciding whether login metadata/session
    // creation may proceed so a concurrent promotion cannot cross this point.
    const [finalUser] = await executeRows<{ role: User["role"] }>(
      tx,
      sql`
        select ${users.role} as role
        from ${users}
        where ${users.id} = ${user.id}
        limit 1
        for no key update
      `,
    );
    if (finalUser?.role === "admin") {
      return {
        result: { status: "invalid" } satisfies MagicLinkConsumption,
        rejectionEvent: {
          reason: "invalid" as const,
          boundary: "admin",
          tokenId: consumed.id,
          keyId: resolved.keyId,
          userId: user.id,
        },
      };
    }
    await touchLastLogin(user.id, meta?.locale, tx);
    const session = await createSession(user.id, { ip: meta?.ip, userAgent: meta?.userAgent }, tx);
    return {
      result: {
        status: "consumed",
        user,
        redirectPath: normalizeMagicLinkRedirectPath(consumed.redirectPath),
        session,
      } satisfies MagicLinkConsumption,
      consumedEvent: {
        tokenId: consumed.id,
        keyId: resolved.keyId,
        userId: user.id,
      },
    };
  });

  if (outcome.result.status !== "consumed") {
    await recordEvent("magic_link_rejected", outcome.rejectionEvent);
    return outcome.result;
  }

  await recordEvent("user_login", { userId: outcome.result.user.id });
  await recordEvent("magic_link_consumed", outcome.consumedEvent);
  return outcome.result;
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

/**
 * Use PostgreSQL wall time rather than a transaction-start `now()`: a worker
 * can wait on the email advisory lock while holding its task row. A current
 * task lease remains a mandatory claim fence; only reservation-until is an
 * observation timestamp that cannot revoke the UUID generation by itself.
 */
async function hasCurrentMagicLinkTaskLease(
  tx: Pick<DbClient, "execute">,
  taskId: string,
): Promise<boolean> {
  const [row] = await executeRows<{ leaseIsCurrent: boolean | string | null }>(
    tx,
    sql`
      select ${tasks.leaseUntil} > clock_timestamp() as "leaseIsCurrent"
      from ${tasks}
      where ${eq(tasks.id, taskId)}
    `,
  );
  return row?.leaseIsCurrent === true || row?.leaseIsCurrent === "t";
}

function parseMagicLinkDatabaseTimestamp(value: Date | string, field: string): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Magic Link query returned an invalid ${field} timestamp`);
  }
  return parsed;
}
