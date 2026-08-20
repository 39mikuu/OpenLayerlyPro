import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { appSettings, siteSettings } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { PUBLIC_INTEGRATIONS_KEY } from "@/modules/site/public-security";

import { getIntegrationStatuses } from "./registry";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("integration status snapshot reads", () => {
  const db = getDb();
  const countedRaw = postgres(getEnv().DATABASE_URL, { max: 1, onnotice: () => {} });
  const queryCounter = {
    count: 0,
    logQuery: () => {
      queryCounter.count += 1;
    },
  };
  const countedDb = drizzle(countedRaw, { schema, logger: queryCounter });

  afterAll(async () => {
    await countedRaw.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await db.delete(appSettings);
    await db.delete(siteSettings);
  });

  it("uses two database queries and isolates one corrupt config group", async () => {
    await db.insert(appSettings).values({
      key: "turnstile",
      valueEncrypted: "corrupt-encrypted-payload",
      revision: 3,
    });
    await db.insert(siteSettings).values({
      key: PUBLIC_INTEGRATIONS_KEY,
      valueJson: [
        {
          id: "analytics",
          provider: "plausible",
          domain: "artist.example",
        },
      ],
    });
    queryCounter.count = 0;

    const statuses = await getIntegrationStatuses(countedDb);

    expect(queryCounter.count).toBe(2);
    expect(statuses.map((status) => status.id)).toEqual([
      "smtp",
      "storage",
      "stripe",
      "turnstile",
      "translation",
      "plausible",
      "umami",
      "oauth_google",
      "oauth_github",
      "tunnel",
    ]);
    expect(statuses.find((status) => status.id === "turnstile")).toEqual({
      id: "turnstile",
      kind: "service",
      configured: false,
      enabled: false,
      source: "none",
      error: true,
    });
    expect(statuses.find((status) => status.id === "smtp")?.error).toBeUndefined();
    expect(statuses.find((status) => status.id === "plausible")).toMatchObject({
      configured: true,
      enabled: true,
      source: "database",
    });
    expect(statuses.find((status) => status.id === "umami")).toMatchObject({
      configured: false,
      enabled: false,
      source: "none",
    });
  });
});
