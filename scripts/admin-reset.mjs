import { randomUUID } from "node:crypto";

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
        ${tx.json({ email: user.email, role: "admin", sessionsRevoked: revoked.length })},
        ${randomUUID()}, null
      )
    `;
    return { email: user.email, sessionsRevoked: revoked.length };
  });
  console.log(
    `Administrator account recovered for ${result.email}; revoked ${result.sessionsRevoked} session(s).`,
  );
} catch (error) {
  console.error("Administrator recovery failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
