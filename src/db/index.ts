import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "@/lib/env";

import * as schema from "./schema";

type Db = ReturnType<typeof createDb>;
export type TxClient = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Db 或事务对象，供模块函数在事务内外复用 */
export type DbClient = Db | TxClient;

function createDb() {
  const client = postgres(getEnv().DATABASE_URL, {
    max: 10,
    onnotice: () => {},
  });
  return drizzle(client, { schema });
}

const globalForDb = globalThis as unknown as { __db?: Db };

export function getDb(): Db {
  if (!globalForDb.__db) {
    globalForDb.__db = createDb();
  }
  return globalForDb.__db;
}

export async function closeDb(): Promise<void> {
  const db = globalForDb.__db;
  if (!db) return;
  globalForDb.__db = undefined;
  await db.$client.end({ timeout: 5 });
}

export { schema };
