import { readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getEnv } from "@/lib/env";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("preset tier commerce migration", () => {
  const db = postgres(getEnv().DATABASE_URL, { max: 1, onnotice: () => {} });
  let migrationSql: string;

  beforeEach(async () => {
    migrationSql = await readFile(
      path.join(process.cwd(), "src/db/migrations/0038_preset_tier_commerce.sql"),
      "utf8",
    );
    await db.unsafe(`
      drop table if exists pg_temp.membership_tiers;
      create temporary table membership_tiers (
        slug text primary key,
        description text,
        price_label text not null,
        price_amount_minor bigint,
        currency text,
        updated_at timestamptz not null default now()
      );
    `);
  });

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  it("fills only missing fields on recognizable presets and is idempotent", async () => {
    await db.unsafe(`
      insert into membership_tiers
        (slug, description, price_label, price_amount_minor, currency, updated_at)
      values
        ('supporter', null, '¥9 / 月', null, null, '2025-01-01T00:00:00Z'),
        ('hd-member', null, '¥29 / 月', 2900, 'CNY', '2025-01-01T00:00:00Z'),
        ('pack-member', '   ', '¥59 / 月', null, 'cny', '2025-01-01T00:00:00Z'),
        ('custom-supporter', null, '¥9 / 月', null, null, '2025-01-01T00:00:00Z');
    `);

    await db.unsafe(migrationSql);
    const firstPass = await db`
      select slug, description, price_label,
             price_amount_minor::integer as "priceAmountMinor", currency, updated_at
      from membership_tiers
      order by slug
    `;

    expect(firstPass).toMatchObject([
      {
        slug: "custom-supporter",
        description: null,
        priceAmountMinor: null,
        currency: null,
      },
      {
        slug: "hd-member",
        description: "查看高清原图与高分辨率会员内容。",
        priceAmountMinor: 2900,
        currency: "CNY",
      },
      {
        slug: "pack-member",
        description: "解锁高清内容，并下载创作素材包与配套资源。",
        priceAmountMinor: null,
        currency: "cny",
      },
      {
        slug: "supporter",
        description: "支持创作者持续更新，并获得支持者身份与基础会员内容。",
        priceAmountMinor: 900,
        currency: "cny",
      },
    ]);

    await db.unsafe(migrationSql);
    const secondPass = await db`
      select slug, description, price_label,
             price_amount_minor::integer as "priceAmountMinor", currency, updated_at
      from membership_tiers
      order by slug
    `;
    expect(secondPass).toEqual(firstPass);
  });

  it("keeps partially customized structured prices non-payable", async () => {
    await db.unsafe(`
      insert into membership_tiers
        (slug, description, price_label, price_amount_minor, currency, updated_at)
      values
        ('supporter', null, '¥9 / 月', null, 'usd', '2025-01-01T00:00:00Z'),
        ('hd-member', null, '¥29 / 月', 3100, null, '2025-01-01T00:00:00Z');
    `);

    await db.unsafe(migrationSql);

    await expect(db`
      select slug, description,
             price_amount_minor::integer as "priceAmountMinor", currency
      from membership_tiers
      order by slug
    `).resolves.toMatchObject([
      {
        slug: "hd-member",
        description: "查看高清原图与高分辨率会员内容。",
        priceAmountMinor: 3100,
        currency: null,
      },
      {
        slug: "supporter",
        description: "支持创作者持续更新，并获得支持者身份与基础会员内容。",
        priceAmountMinor: null,
        currency: "usd",
      },
    ]);
  });

  it("does not reinterpret a preset slug after its displayed price was customized", async () => {
    await db.unsafe(`
      insert into membership_tiers
        (slug, description, price_label, price_amount_minor, currency, updated_at)
      values ('supporter', null, '¥12 / 月', null, null, '2025-01-01T00:00:00Z');
    `);

    await db.unsafe(migrationSql);

    await expect(db`
      select slug, description, price_label as "priceLabel",
             price_amount_minor::integer as "priceAmountMinor", currency, updated_at
      from membership_tiers
    `).resolves.toMatchObject([
      {
        slug: "supporter",
        description: null,
        priceLabel: "¥12 / 月",
        priceAmountMinor: null,
        currency: null,
      },
    ]);
  });
});
