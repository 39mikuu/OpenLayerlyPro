import postgres from "postgres";

import { decryptSecret } from "@/lib/crypto";
import { getConfigEncryptionKey } from "@/modules/security/config-key";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("restore-config-key-probe: missing DATABASE_URL");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

try {
  getConfigEncryptionKey();

  const rows = await sql`
    select key, value_encrypted
    from app_settings
    -- value_encrypted is NOT NULL today; keep this predicate defensive for old dumps.
    where value_encrypted is not null
    order by key
  `;

  if (rows.length === 0) {
    console.log("restore-config-key-probe: no encrypted app_settings values found; skipping");
  } else {
    for (const row of rows) {
      try {
        decryptSecret(row.value_encrypted ?? row.valueEncrypted);
      } catch (error) {
        const key = typeof row.key === "string" ? row.key : "unknown";
        throw new Error(
          `failed to decrypt app_settings key ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    console.log(
      `restore-config-key-probe: decrypted ${rows.length} encrypted app_settings value(s)`,
    );
  }
} catch (error) {
  console.error(
    "restore-config-key-probe: active CONFIG_ENCRYPTION_KEY cannot decrypt restored app_settings",
  );
  console.error(
    `restore-config-key-probe: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
