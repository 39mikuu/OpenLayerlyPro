import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb, schema } from "@/db";
import { loginCodes } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import {
  hasOtherRestoreDatabaseClients,
  hasOutstandingLoginCodeSmtpReservations,
} from "./loginCodeSmtpReservations";

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

  it("refuses startup while another client is connected to the restored database", async () => {
    const databaseName = `restore_clients_${randomUUID().replaceAll("-", "")}`;
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    const check = postgres(url.toString(), { max: 1 });
    const owner = postgres(url.toString(), { max: 1 });
    let created = false;
    let ownerClosed = false;
    try {
      await admin.unsafe(`create database ${databaseName}`);
      created = true;
      expect(await hasOtherRestoreDatabaseClients(drizzle(check, { schema }))).toBe(false);
      await owner`select 1`;
      expect(await hasOtherRestoreDatabaseClients(drizzle(check, { schema }))).toBe(true);
      await owner.end({ timeout: 5 });
      ownerClosed = true;
      expect(await hasOtherRestoreDatabaseClients(drizzle(check, { schema }))).toBe(false);
    } finally {
      if (!ownerClosed) await owner.end({ timeout: 5 });
      await check.end({ timeout: 5 });
      if (created) await admin.unsafe(`drop database ${databaseName}`);
      await admin.end({ timeout: 5 });
    }
  });
});
