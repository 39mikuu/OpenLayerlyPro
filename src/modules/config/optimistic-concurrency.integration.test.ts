import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { getEnv } from "@/lib/env";

import { deleteStoredGroup, getStoredGroupSnapshot, setStoredGroup } from "./store";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type SmtpGroup = {
  host?: string;
  from?: string;
  password?: string;
};

describeWithDatabase("config optimistic concurrency", () => {
  const rawA = postgres(getEnv().DATABASE_URL, { max: 1, onnotice: () => {} });
  const rawB = postgres(getEnv().DATABASE_URL, { max: 1, onnotice: () => {} });
  const dbA = drizzle(rawA, { schema });
  const dbB = drizzle(rawB, { schema });

  beforeEach(async () => {
    await rawA`truncate table app_settings`;
  });

  afterAll(async () => {
    await Promise.all([rawA.end({ timeout: 5 }), rawB.end({ timeout: 5 })]);
  });

  function expectSingleConflict(results: PromiseSettledResult<number>[]) {
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409, code: "configConflict" });
  }

  it("conflicts ordinary-field and secret saves from the same revision", async () => {
    await setStoredGroup<SmtpGroup>(
      "smtp",
      { host: "old-host", from: "old@example.test", password: "old-secret" },
      0,
      dbA,
    );

    const results = await Promise.allSettled([
      setStoredGroup<SmtpGroup>(
        "smtp",
        { host: "new-host", from: "old@example.test", password: "old-secret" },
        1,
        dbA,
      ),
      setStoredGroup<SmtpGroup>(
        "smtp",
        { host: "old-host", from: "old@example.test", password: "new-secret" },
        1,
        dbB,
      ),
    ]);

    expectSingleConflict(results);
    expect((await getStoredGroupSnapshot<SmtpGroup>("smtp", dbA)).revision).toBe(2);
  });

  it("allows only one of two secret saves", async () => {
    await setStoredGroup<SmtpGroup>("smtp", { password: "initial" }, 0, dbA);

    const results = await Promise.allSettled([
      setStoredGroup<SmtpGroup>("smtp", { password: "secret-a" }, 1, dbA),
      setStoredGroup<SmtpGroup>("smtp", { password: "secret-b" }, 1, dbB),
    ]);

    expectSingleConflict(results);
    const final = await getStoredGroupSnapshot<SmtpGroup>("smtp", dbA);
    expect(["secret-a", "secret-b"]).toContain(final.value?.password);
  });

  it("keeps clear ahead of a stale save and preserves its tombstone revision", async () => {
    await setStoredGroup<SmtpGroup>("smtp", { password: "must-not-revive" }, 0, dbA);

    await deleteStoredGroup("smtp", 1, dbA);
    await expect(
      setStoredGroup<SmtpGroup>("smtp", { password: "must-not-revive" }, 1, dbB),
    ).rejects.toMatchObject({ status: 409, code: "configConflict" });

    await expect(getStoredGroupSnapshot<SmtpGroup>("smtp", dbA)).resolves.toEqual({
      value: null,
      revision: 2,
    });
  });

  it("rejects a stale masked-secret form after another admin rotates the secret", async () => {
    await setStoredGroup<SmtpGroup>("smtp", { host: "old-host", password: "old-secret" }, 0, dbA);
    await setStoredGroup<SmtpGroup>(
      "smtp",
      { host: "old-host", password: "rotated-secret" },
      1,
      dbA,
    );

    await expect(
      setStoredGroup<SmtpGroup>("smtp", { host: "stale-tab-host", password: "old-secret" }, 1, dbB),
    ).rejects.toMatchObject({ status: 409, code: "configConflict" });
    await expect(getStoredGroupSnapshot<SmtpGroup>("smtp", dbA)).resolves.toMatchObject({
      value: { host: "old-host", password: "rotated-secret" },
      revision: 2,
    });
  });

  it("does not reuse a revision after clear and recreate", async () => {
    await setStoredGroup<SmtpGroup>("smtp", { host: "first" }, 0, dbA);
    await deleteStoredGroup("smtp", 1, dbA);
    await setStoredGroup<SmtpGroup>("smtp", { host: "recreated" }, 2, dbA);

    await expect(
      setStoredGroup<SmtpGroup>("smtp", { host: "stale-first-tab" }, 1, dbB),
    ).rejects.toMatchObject({ status: 409, code: "configConflict" });
    await expect(getStoredGroupSnapshot<SmtpGroup>("smtp", dbA)).resolves.toMatchObject({
      value: { host: "recreated" },
      revision: 3,
    });
  });
});
