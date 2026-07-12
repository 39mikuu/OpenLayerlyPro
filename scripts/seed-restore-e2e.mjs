import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import bcrypt from "bcryptjs";
import postgres from "postgres";

import { encryptSecret } from "@/lib/crypto";

const DATABASE_URL = process.env.DATABASE_URL;
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/app/uploads";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "restore-e2e@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "restore-e2e-password-0123";
const MEMBER_EMAIL = process.env.MEMBER_EMAIL ?? "restore-e2e-member@example.com";
const MEMBER_PASSWORD = process.env.MEMBER_PASSWORD ?? "restore-e2e-member-pass-01";
const SMTP_MARKER = "restore-e2e-smtp-host.example.com";

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

try {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const memberPasswordHash = await bcrypt.hash(MEMBER_PASSWORD, 12);
  const postId = randomUUID();
  const quarantineFileId = randomUUID();
  const intactFileId = randomUUID();
  const quarantineObjectKey = `restore-e2e/${quarantineFileId}.txt`;
  const intactObjectKey = `restore-e2e/${intactFileId}.txt`;
  const tierId = randomUUID();
  const subscriptionId = randomUUID();
  // The renewal payload points at a *stale* period (different from the subscription's
  // real current period) so shouldSendRenewalReminderEmail() returns false and, after
  // restore re-arms the task, the worker settles it as a deterministic no-op success
  // (independent of the unreachable drill SMTP host).
  const renewalStalePeriodIso = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

  for (const objectKey of [quarantineObjectKey, intactObjectKey]) {
    const uploadPath = path.join(UPLOAD_DIR, objectKey);
    await mkdir(path.dirname(uploadPath), { recursive: true });
    await writeFile(uploadPath, `restore-e2e-marker:${objectKey}\n`, "utf8");
  }

  const smtpEncrypted = encryptSecret(
    JSON.stringify({
      host: SMTP_MARKER,
      port: 587,
      secure: false,
      user: "restore-e2e",
      password: "smtp-secret",
      from: "restore-e2e@example.com",
    }),
  );

  // A complete-but-dummy Stripe config so the recurring subscription.reconcile task can
  // construct a provider and run successfully. The only seeded subscription is manual
  // (provider IS NULL, no provider refs), so reconcile skips it without any network
  // call and settles as a no-op success — letting us assert a concrete deferred state.
  const stripeEncrypted = encryptSecret(
    JSON.stringify({
      enabled: true,
      secretKey: "sk_test_restore_e2e_dummy",
      webhookSecret: "whsec_restore_e2e_dummy",
    }),
  );

  await sql.begin(async (tx) => {
    const [admin] = await tx`
      insert into users (email, password_hash, role, updated_at)
      values (${ADMIN_EMAIL}, ${passwordHash}, 'admin', now())
      on conflict (email) do update
      set password_hash = excluded.password_hash,
          role = 'admin',
          updated_at = now()
      returning id
    `;

    const [member] = await tx`
      insert into users (email, password_hash, role, updated_at)
      values (${MEMBER_EMAIL}, ${memberPasswordHash}, 'member', now())
      on conflict (email) do update
      set password_hash = excluded.password_hash,
          role = 'member',
          updated_at = now()
      returning id
    `;

    await tx`
      insert into membership_tiers (
        id, name, slug, price_label, level, duration_days, updated_at
      )
      values (
        ${tierId},
        'Restore E2E Tier',
        'restore-e2e-tier',
        'E2E',
        1,
        31,
        now()
      )
      on conflict (slug) do update
      set name = excluded.name,
          updated_at = now()
    `;

    await tx`
      insert into memberships (
        user_id, tier_id, source, starts_at, ends_at, status, updated_at
      )
      values (
        ${member.id},
        ${tierId},
        'manual',
        now() - interval '1 day',
        now() + interval '30 days',
        'active',
        now()
      )
    `;

    await tx`
      insert into subscriptions (
        id, user_id, tier_id, status, provider, current_period_ends_at, updated_at
      )
      values (
        ${subscriptionId},
        ${member.id},
        ${tierId},
        'active',
        null,
        now() + interval '30 days',
        now()
      )
    `;

    await tx`
      insert into app_settings (key, value_encrypted, updated_at)
      values ('smtp', ${smtpEncrypted}, now())
      on conflict (key) do update
      set value_encrypted = excluded.value_encrypted,
          updated_at = now()
    `;

    await tx`
      insert into app_settings (key, value_encrypted, updated_at)
      values ('stripe', ${stripeEncrypted}, now())
      on conflict (key) do update
      set value_encrypted = excluded.value_encrypted,
          updated_at = now()
    `;

    await tx`
      insert into files (
        id, purpose, storage_driver, bucket, object_key, original_name,
        mime_type, size_bytes, created_by, updated_at
      )
      values (
        ${quarantineFileId}, 'content_attachment', 'local', null, ${quarantineObjectKey},
        'marker.txt', 'text/plain', 18, ${admin.id}, now()
      )
    `;

    await tx`
      insert into files (
        id, purpose, storage_driver, bucket, object_key, original_name,
        mime_type, size_bytes, created_by, updated_at
      )
      values (
        ${intactFileId}, 'content_attachment', 'local', null, ${intactObjectKey},
        'marker.txt', 'text/plain', 18, ${admin.id}, now()
      )
    `;

    await tx`
      insert into posts (
        id, title, slug, body, visibility, status, published_at, updated_at
      )
      values (
        ${postId},
        'Restore E2E Marker',
        'restore-e2e-marker',
        'seeded for S7 restore drill',
        'public',
        'published',
        now(),
        now()
      )
    `;

    await tx`
      insert into post_files (post_id, file_id, kind)
      values
        (${postId}, ${intactFileId}, 'inline'),
        (${postId}, ${quarantineFileId}, 'inline')
    `;

    await tx`
      insert into tasks (kind, dedupe_key, payload_json, status, attempts, updated_at)
      values (
        'storage.delete_object',
        ${`storage:delete_object:${quarantineFileId}`},
        ${sql.json({
          storageDriver: "local",
          bucket: null,
          objectKey: quarantineObjectKey,
        })},
        'succeeded',
        1,
        now()
      )
      on conflict (dedupe_key) do nothing
    `;

    // A valid normalized "ignored" provider event (a Stripe event the app classifies as
    // a no-op). Restore re-arms it and the worker must replay it to a real terminal
    // 'processed'/'succeeded' — not pass merely because an untyped payload falls through
    // the dispatcher switch. "ignored" needs no Stripe network call.
    const providerEventId = `evt_restore_e2e_${randomUUID()}`;
    const [event] = await tx`
      insert into payment_provider_events (
        provider, provider_event_id, event_type, provider_created_at,
        payload_json, status, attempts, updated_at
      )
      values (
        'stripe',
        ${providerEventId},
        'customer.updated',
        now(),
        ${sql.json({ type: "ignored", providerEventId })},
        'processing',
        2,
        now()
      )
      returning id
    `;

    await tx`
      insert into tasks (kind, dedupe_key, payload_json, status, attempts, locked_by, updated_at)
      values (
        'payment_provider_event.dispatch',
        ${`payment-provider-event:${event.id}`},
        ${sql.json({ eventRowId: event.id })},
        'processing',
        2,
        'stale-worker',
        now()
      )
      on conflict (dedupe_key) do nothing
    `;

    await tx`
      insert into tasks (kind, dedupe_key, payload_json, status, attempts, locked_by, updated_at)
      values
      (
        'email',
        ${`email:membership_activated:${randomUUID()}`},
        ${sql.json({
          version: 2,
          template: "membership_activated",
          paymentRequestId: randomUUID(),
          membershipId: randomUUID(),
        })},
        'processing',
        1,
        'stale-worker',
        now()
      ),
      (
        'email',
        ${`email:renewal_reminder:${randomUUID()}`},
        ${sql.json({
          version: 2,
          template: "renewal_reminder",
          subscriptionId,
          periodEndsAt: renewalStalePeriodIso,
        })},
        'processing',
        1,
        'stale-worker',
        now()
      ),
      (
        'subscription.reconcile',
        'subscription.reconcile',
        ${sql.json({})},
        'dead',
        3,
        null,
        now()
      )
      on conflict (dedupe_key) do nothing
    `;
  });

  console.log(
    JSON.stringify(
      {
        adminEmail: ADMIN_EMAIL,
        memberEmail: MEMBER_EMAIL,
        postSlug: "restore-e2e-marker",
        tierSlug: "restore-e2e-tier",
        quarantineFileId,
        intactFileId,
        smtpMarker: SMTP_MARKER,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
