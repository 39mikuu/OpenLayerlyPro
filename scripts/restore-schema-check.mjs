import { isSchemaCheckPassing, runRestoreSchemaCheck } from "@/modules/restore/schemaCheck";

function readArg(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const databaseUrl = readArg("database-url") ?? process.env.DATABASE_URL;
const manifestPath = readArg("manifest-path");
const formatVersion = Number(readArg("format-version"));
const allowLegacyV1UnknownSchema = process.argv.includes("--allow-legacy-v1-unknown-schema");

if (!Number.isInteger(formatVersion) || formatVersion < 1) {
  console.error("--format-version must be a positive integer");
  process.exit(1);
}

try {
  const report = await runRestoreSchemaCheck({
    databaseUrl,
    formatVersion,
    manifestPath,
    allowLegacyV1UnknownSchema,
  });

  for (const warning of report.warnings) {
    console.error(`WARNING: ${warning}`);
  }

  console.log(JSON.stringify(report, null, 2));

  if (!isSchemaCheckPassing(report)) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
