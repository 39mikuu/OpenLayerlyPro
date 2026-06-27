import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import bcrypt from "bcryptjs";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/app/uploads";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "restore-e2e@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "restore-e2e-password-0123";

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

try {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const postId = randomUUID();
  const fileId = randomUUID();
  const objectKey = `restore-e2e/${fileId}.txt`;
  const uploadPath = path.join(UPLOAD_DIR, objectKey);
  await mkdir(path.dirname(uploadPath), { recursive: true });
  await writeFile(uploadPath, "restore-e2e-marker\n", "utf8");

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

    await tx`
      insert into files (
        id, purpose, storage_driver, bucket, object_key, original_name,
        mime_type, size_bytes, created_by, updated_at
      )
      values (
        ${fileId}, 'content_image', 'local', null, ${objectKey}, 'marker.txt',
        'text/plain', 18, ${admin.id}, now()
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
      values (${postId}, ${fileId}, 'inline')
    `;

    await tx`
      insert into tasks (kind, dedupe_key, payload_json, status, attempts, updated_at)
      values (
        'storage.delete_object',
        ${`storage:delete_object:${fileId}`},
        ${sql.json({
          storageDriver: "local",
          bucket: null,
          objectKey,
        })},
        'succeeded',
        1,
        now()
      )
      on conflict (dedupe_key) do nothing
    `;

    const [event] = await tx`
      insert into payment_provider_events (
        provider, provider_event_id, event_type, provider_created_at,
        payload_json, status, attempts, updated_at
      )
      values (
        'stripe',
        ${`evt_restore_e2e_${randomUUID()}`},
        'invoice.paid',
        now(),
        ${sql.json({ id: "evt_restore_e2e" })},
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
  });

  console.log(
    JSON.stringify(
      {
        adminEmail: ADMIN_EMAIL,
        postSlug: "restore-e2e-marker",
        fileId,
        objectKey,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}