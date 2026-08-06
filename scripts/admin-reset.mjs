import { createHmac, randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? "";
const PASSWORD_COST = 12;
const MIN_PASSWORD_LENGTH = 8;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("ADMIN_EMAIL must be a valid email address");
  process.exit(1);
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`ADMIN_PASSWORD must contain at least ${MIN_PASSWORD_LENGTH} characters`);
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

try {
  const passwordHash = await bcrypt.hash(password, PASSWORD_COST);
  const result = await sql.begin(async (tx) => {
    // Use the same lock order as the application promotion paths: email
    // advisory lock, pending candidates, then the administrator row. A
    // reservation generation is a hard fence even after its observation lease
    // timestamp has passed.
    await tx`select pg_advisory_xact_lock(hashtext(${email}))`;
    const pending = await tx`
      select id, delivery_reservation_id, delivery_reservation_until
      from magic_link_tokens
      where email = ${email}
        and delivery_state = 'pending'
      for update
    `;
    const reserved = pending.filter(
      (candidate) =>
        candidate.delivery_reservation_id !== null || candidate.delivery_reservation_until !== null,
    );
    if (reserved.length > 0) {
      const targetEmailDigest = createHmac("sha256", DATABASE_URL).update(email).digest("hex");
      await tx`
        insert into audit_events (
          id, entity_type, entity_id, action, actor_type, actor_id,
          reason, before_json, after_json, correlation_id, causation_id
        ) values (
          ${randomUUID()}, 'magic_link', ${reserved[0].id}, 'magic_link_promotion_blocked',
          'system', null, 'CLI administrator recovery blocked by an SMTP reservation', null,
          ${tx.json({
            path: "admin_reset",
            reservedCandidateCount: reserved.length,
            targetEmailDigest,
          })},
          ${randomUUID()}, null
        )
      `;
      await tx`
        insert into app_events (type, payload_json)
        values (
          'magic_link_promotion_blocked',
          ${tx.json({
            path: "admin_reset",
            reservedCandidateCount: reserved.length,
            targetEmailDigest,
          })}
        )
      `;
      return { blocked: true, reservedCandidateCount: reserved.length };
    }

    const pendingIds = pending.map((candidate) => candidate.id);
    const cancelled =
      pendingIds.length === 0
        ? []
        : await tx`
            update magic_link_tokens
            set delivery_state = 'cancelled',
                expires_at = now(),
                delivery_reservation_id = null,
                delivery_reservation_until = null
            where id = any(${tx.array(pendingIds, "uuid")})
              and delivery_state = 'pending'
              and delivery_reservation_id is null
              and delivery_reservation_until is null
            returning id
          `;
    if (cancelled.length !== pendingIds.length) {
      throw new Error("Magic Link promotion fence lost a locked pending candidate");
    }

    for (const candidate of cancelled) {
      const [ledger] = await tx`
        select request_id, minted_token_id, delivery_task_id
        from magic_link_mint_ledger
        where minted_token_id = ${candidate.id}
        for update
      `;
      if (!ledger) {
        throw new Error("Magic Link pending candidate is missing its immutable mint ledger");
      }

      const [existingDisposition] = await tx`
        select final_state, reservation_id
        from magic_link_delivery_dispositions
        where candidate_id = ${candidate.id}
        for update
      `;
      if (existingDisposition) {
        if (
          existingDisposition.final_state !== "cancelled" ||
          existingDisposition.reservation_id !== null
        ) {
          throw new Error("Magic Link candidate has a conflicting disposition record");
        }
        continue;
      }
      await tx`
        insert into magic_link_delivery_dispositions (
          candidate_id, request_id, minted_token_id, delivery_task_id, final_state, reservation_id
        ) values (
          ${candidate.id}, ${ledger.request_id}, ${ledger.minted_token_id}, ${ledger.delivery_task_id},
          'cancelled', null
        )
      `;
    }

    if (cancelled.length > 0) {
      await tx`
        delete from magic_link_stuck_fence_alerts
        where candidate_id = any(${tx.array(
          cancelled.map((candidate) => candidate.id),
          "uuid",
        )})
      `;
    }

    const [user] = await tx`
      insert into users (email, password_hash, role, updated_at)
      values (${email}, ${passwordHash}, 'admin', now())
      on conflict (email) do update
      set password_hash = excluded.password_hash,
          role = 'admin',
          updated_at = now()
      returning id, email
    `;
    const revoked = await tx`
      delete from sessions
      where user_id = ${user.id}
      returning id
    `;
    await tx`
      insert into audit_events (
        id, entity_type, entity_id, action, actor_type, actor_id,
        reason, before_json, after_json, correlation_id, causation_id
      )
      values (
        ${randomUUID()}, 'admin', ${user.id}, 'account_recovered', 'system', null,
        'CLI administrator recovery', null,
        ${tx.json({
          role: "admin",
          sessionsRevoked: revoked.length,
          cancelledPendingMagicLinks: cancelled.length,
          promotionFenceChecked: true,
        })},
        ${randomUUID()}, null
      )
    `;
    return {
      blocked: false,
      email: user.email,
      sessionsRevoked: revoked.length,
      cancelledPendingMagicLinks: cancelled.length,
    };
  });

  if (result.blocked) {
    console.error(
      `Administrator recovery was safely blocked by ${result.reservedCandidateCount} in-flight login-link delivery fence(s); retry after the delivery is resolved.`,
    );
    process.exitCode = 2;
  } else {
    console.log(
      `Administrator account recovered for ${result.email}; revoked ${result.sessionsRevoked} session(s) and cancelled ${result.cancelledPendingMagicLinks} pending login link(s).`,
    );
  }
} catch (error) {
  console.error("Administrator recovery failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
