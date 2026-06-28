import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { getStorageConfig } from "@/modules/config/storageResolve";

function readArg(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const missingObjectKey = readArg("missing");
const orphanObjectKey = readArg("orphan");

if (!missingObjectKey) {
  console.error("Missing --missing=<object-key>");
  process.exit(1);
}

const storageConfig = await getStorageConfig();
if (
  storageConfig.driver !== "s3" ||
  !storageConfig.endpoint ||
  !storageConfig.bucket ||
  !storageConfig.accessKeyId ||
  !storageConfig.secretAccessKey
) {
  console.error("S3 storage configuration is incomplete");
  process.exit(1);
}

const s3 = new S3Client({
  endpoint: storageConfig.endpoint,
  region: storageConfig.region,
  forcePathStyle: storageConfig.forcePathStyle,
  credentials: {
    accessKeyId: storageConfig.accessKeyId,
    secretAccessKey: storageConfig.secretAccessKey,
  },
});

try {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: storageConfig.bucket,
      Key: missingObjectKey,
    }),
  );

  if (orphanObjectKey) {
    await s3.send(
      new PutObjectCommand({
        Bucket: storageConfig.bucket,
        Key: orphanObjectKey,
        Body: "restore-s3-e2e-injected-orphan\n",
        ContentType: "text/plain",
      }),
    );
  }

  console.log(
    JSON.stringify(
      {
        deleted: missingObjectKey,
        orphanAdded: orphanObjectKey ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
} finally {
  s3.destroy();
}