import { and, count, eq, gt, lte, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { downloadLogs, files, memberships, paymentRequests, posts, users } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getIntegrationStatuses, type IntegrationStatus } from "@/modules/integration";

import packageJson from "../../../package.json";

export type SystemStatus = {
  appUrl: string;
  version: string;
  databaseOk: boolean;
  integrations: IntegrationStatus[];
};

export async function getSystemStatus(): Promise<SystemStatus> {
  const env = getEnv();
  const [databaseOk, integrations] = await Promise.all([
    (async () => {
      try {
        await getDb().execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    })(),
    getIntegrationStatuses(),
  ]);

  return {
    appUrl: env.APP_URL,
    version: packageJson.version,
    databaseOk,
    integrations,
  };
}

export type DashboardStats = {
  userCount: number;
  activeMemberCount: number;
  pendingPaymentCount: number;
  publishedPostCount: number;
  fileCount: number;
  downloadCount: number;
};

export async function getDashboardStats(): Promise<DashboardStats> {
  const db = getDb();
  const now = new Date();
  const [[u], [m], [p], [po], [f], [d]] = await Promise.all([
    db.select({ c: count() }).from(users),
    db
      .select({ c: sql<number>`count(distinct ${memberships.userId})` })
      .from(memberships)
      .where(
        and(
          eq(memberships.status, "active"),
          lte(memberships.startsAt, now),
          gt(memberships.endsAt, now),
        ),
      ),
    db
      .select({ c: count() })
      .from(paymentRequests)
      .where(eq(paymentRequests.status, "pending_review")),
    db.select({ c: count() }).from(posts).where(eq(posts.status, "published")),
    db.select({ c: count() }).from(files),
    db.select({ c: count() }).from(downloadLogs),
  ]);
  return {
    userCount: Number(u.c),
    activeMemberCount: Number(m.c),
    pendingPaymentCount: Number(p.c),
    publishedPostCount: Number(po.c),
    fileCount: Number(f.c),
    downloadCount: Number(d.c),
  };
}
