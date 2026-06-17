/**
 * 数据库迁移脚本（dev 与生产容器统一入口）。
 * 开发：pnpm db:migrate
 * 生产：docker/entrypoint.sh 在启动应用前显式执行打包后的 dist/migrate.mjs
 */
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL 环境变量");
  process.exit(1);
}

const migrationsFolder =
  process.env.MIGRATIONS_FOLDER ?? path.join(process.cwd(), "src", "db", "migrations");
const maxAttempts = Number(process.env.MIGRATE_MAX_ATTEMPTS ?? 30);
const retryDelayMs = 2000;

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log("数据库迁移完成");
    await client.end({ timeout: 5 });
    process.exit(0);
  } catch (err) {
    await client.end({ timeout: 5 }).catch(() => {});
    if (attempt === maxAttempts) {
      console.error("数据库迁移失败:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    console.log(`数据库暂不可用，${retryDelayMs / 1000} 秒后重试 (${attempt}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
}
