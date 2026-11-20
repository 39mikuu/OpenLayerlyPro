import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db";
import { readerInvitations, users } from "@/db/schema";

import { canEnterInside } from "./access";
import {
  createReaderInvitation,
  redeemReaderInvitation,
  revokeReaderInvitation,
} from "./invitations";

describe.skipIf(process.env.RUN_DB_INTEGRATION_TESTS !== "true")(
  "reader invitation transactions",
  () => {
    afterAll(closeDb);

    it("binds to the verified account, redeems once under concurrency and supports revocation", async () => {
      const db = getDb();
      const [author, reader, stranger] = await db
        .insert(users)
        .values([
          { email: `${randomUUID()}@example.test`, role: "admin" },
          { email: `${randomUUID()}@example.test` },
          { email: `${randomUUID()}@example.test` },
        ])
        .returning();
      try {
        const token = await createReaderInvitation(reader.email, author.id);
        expect(await canEnterInside(reader)).toBe(false);
        expect(await redeemReaderInvitation(token, stranger)).toBe(false);
        const results = await Promise.all([
          redeemReaderInvitation(token, reader),
          redeemReaderInvitation(token, reader),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await canEnterInside(reader)).toBe(true);
        expect(await canEnterInside(stranger)).toBe(false);
        const [grant] = await db
          .select()
          .from(readerInvitations)
          .where(eq(readerInvitations.redeemedBy, reader.id));
        expect(grant.tokenHash).not.toBe(token);
        await revokeReaderInvitation(grant.id, author.id);
        expect(await canEnterInside(reader)).toBe(false);
        expect(await redeemReaderInvitation(token, reader)).toBe(false);

        const expired = await createReaderInvitation(reader.email, author.id);
        await db
          .update(readerInvitations)
          .set({ expiresAt: new Date(0) })
          .where(eq(readerInvitations.email, reader.email));
        expect(await redeemReaderInvitation(expired, reader)).toBe(false);
      } finally {
        await db.delete(readerInvitations).where(eq(readerInvitations.email, reader.email));
        await db.delete(users).where(inArray(users.id, [author.id, reader.id, stranger.id]));
      }
    });
  },
);
