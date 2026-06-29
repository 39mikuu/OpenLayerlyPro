import { randomUUID } from "node:crypto";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import bcrypt from "bcryptjs";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "restore-s3-e2e@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "restore-s3-e2e-password-01";
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://minio:9000";
const S3_BUCKET = process.env.S3_BUCKET ?? "openlayerly-s7-e2e";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? "s7minioadmin";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "s7minioadmin-secret-0123";

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: "auto",
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
});

async function putObject(objectKey, body) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: objectKey,
      Body: body,
      ContentType: "text/plain",
    }),
  );
}

try {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const referencedFileId = randomUUID();
  const referencedObjectKey = `content/restore-s3-e2e/${referencedFileId}.txt`;
  const orphanObjectKey = `content/restore-s3-e2e/orphan-${randomUUID()}.txt`;
  // Out-of-prefix sentinel: lives outside the enumerated content/ prefix and has no
  // DB row. Convergence must never list or touch it, proving prefix-boundary scope.
  const sentinelObjectKey = `sentinel/restore-s3-e2e/outside-${randomUUID()}.txt`;
  // Extra referenced objects so a small converge --page-size forces MinIO to return
  // multiple pages (exercises ListObjectsV2 continuation-token pagination).
  const fillerFiles = Array.from({ length: 4 }, () => {
    const id = randomUUID();
    return { id, objectKey: `content/restore-s3-e2e/filler-${id}.txt` };
  });

  await putObject(referencedObjectKey, `restore-s3-e2e-referenced:${referencedFileId}\n`);
  await putObject(orphanObjectKey, "restore-s3-e2e-orphan\n");
  await putObject(sentinelObjectKey, "restore-s3-e2e-sentinel\n");
  for (const filler of fillerFiles) {
    await putObject(filler.objectKey, `restore-s3-e2e-filler:${filler.id}\n`);
  }

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
        ${referencedFileId}, 'content_image', 's3', ${S3_BUCKET}, ${referencedObjectKey},
        'referenced.txt', 'text/plain', 24, ${admin.id}, now()
      )
    `;

    for (const filler of fillerFiles) {
      await tx`
        insert into files (
          id, purpose, storage_driver, bucket, object_key, original_name,
          mime_type, size_bytes, created_by, updated_at
        )
        values (
          ${filler.id}, 'content_image', 's3', ${S3_BUCKET}, ${filler.objectKey},
          'filler.txt', 'text/plain', 24, ${admin.id}, now()
        )
      `;
    }
  });

  console.log(
    JSON.stringify(
      {
        referencedFileId,
        referencedObjectKey,
        orphanObjectKey,
        sentinelObjectKey,
        fillerObjectKeys: fillerFiles.map((filler) => filler.objectKey),
        bucket: S3_BUCKET,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
  s3.destroy();
}
