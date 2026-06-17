import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "@/lib/env";

import * as schema from "./schema";

type Db = ReturnType<typeof createDb>;

/** Db 或事务对象，供模块函数在事务内外复用 */
export type DbClient = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

export { schema };
