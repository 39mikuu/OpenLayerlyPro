export const DEFAULT_DATABASE_URL =
  "postgresql://artist:artist_password@localhost:5432/artist_member";

/** Minimal DB bootstrap config, independent from unrelated application settings. */
export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}
