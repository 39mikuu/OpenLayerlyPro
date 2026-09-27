import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { loginCodes } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import { hasOutstandingLoginCodeSmtpReservations } from "./loginCodeSmtpReservations";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("restore login-code SMTP reservation gate", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  it("allows startup without a reservation and never changes login codes", async () => {
    const [code] = await db
      .insert(loginCodes)
      .values({
        email: "restored@example.test",
        codeHash: "hash",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    expect(await hasOutstandingLoginCodeSmtpReservations(db)).toBe(false);
    const [afterCheck] = await db.select().from(loginCodes).where(eq(loginCodes.id, code.id));
    expect(afterCheck).toEqual(code);
  });

  it("blocks expired or used codes until each exact generation is recovered", async () => {
    const reservations = [randomUUID(), randomUUID()];
    const [expired, used] = await db
      .insert(loginCodes)
      .values([
        {
          email: "expired@example.test",
          codeHash: "hash",
          expiresAt: new Date(Date.now() - 60_000),
          smtpReservationToken: reservations[0],
          smtpReservedAt: new Date(),
        },
        {
          email: "used@example.test",
          codeHash: "hash",
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: new Date(),
          smtpReservationToken: reservations[1],
          smtpReservedAt: new Date(),
        },
      ])
      .returning();

    expect(await hasOutstandingLoginCodeSmtpReservations(db)).toBe(true);
    await db
      .update(loginCodes)
      .set({ smtpReservationToken: null, smtpReservedAt: null })
      .where(eq(loginCodes.id, expired.id));
    expect(await hasOutstandingLoginCodeSmtpReservations(db)).toBe(true);
    await db
      .update(loginCodes)
      .set({ smtpReservationToken: null, smtpReservedAt: null })
      .where(eq(loginCodes.id, used.id));
    expect(await hasOutstandingLoginCodeSmtpReservations(db)).toBe(false);
  });
});
