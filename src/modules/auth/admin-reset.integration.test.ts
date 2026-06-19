import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { promisify } from "util";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { auditEvents, sessions, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/crypto";

const execFileAsync = promisify(execFile);
const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("administrator recovery CLI integration", () => {
  it("resets the password, revokes sessions, and records a system audit", async () => {
    const db = getDb();
    const email = `recovery-${randomUUID()}@example.com`;
    const [admin] = await db
      .insert(users)
      .values({
        email,
        role: "admin",
        passwordHash: await hashPassword("old-password"),
      })
      .returning();
    await db.insert(sessions).values({
      userId: admin.id,
      tokenHash: `old-session-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const { stdout } = await execFileAsync(process.execPath, ["scripts/admin-reset.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        ADMIN_EMAIL: email,
        ADMIN_PASSWORD: "recovered-password",
      },
    });
    expect(stdout).toContain(email);
    expect(stdout).not.toContain("recovered-password");

    const [stored] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(stored?.role).toBe("admin");
    expect(await verifyPassword("recovered-password", stored!.passwordHash!)).toBe(true);
    await expect(
      db.select().from(sessions).where(eq(sessions.userId, admin.id)),
    ).resolves.toHaveLength(0);
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, admin.id), eq(auditEvents.action, "account_recovered")));
    expect(event).toMatchObject({ actorType: "system", actorId: null });
    expect(JSON.stringify(event)).not.toContain(stored!.passwordHash!);
  });
});
