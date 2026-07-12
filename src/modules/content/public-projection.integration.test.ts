// getEnv() caches on first call, so APP_URL must be set before any import
// side effect can read it (same pattern as feed.integration.test.ts).
process.env.APP_URL = "https://seo.example/base";

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as sitemapIndexGET } from "@/app/sitemap.xml/route";
import { GET as postShardGET } from "@/app/sitemaps/posts/[shard]/route";
import { getDb } from "@/db";
import {
  categories,
  files,
  membershipTiers,
  postCategories,
  postTags,
  postTranslations,
  siteSettings,
  tags,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import {
  countPublicPosts,
  countPublicSitemapPostShards,
  listPublicSitemapShard,
  publicPostProjectionQuery,
} from "@/modules/content/public-projection";
import { buildPublicPostMetadata } from "@/modules/content/seo";
import {
  buildPostSitemapShardResource,
  buildSitemapIndexResource,
} from "@/modules/content/sitemap";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type PlanNode = {
  "Node Type"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
};

type ExplainRow = {
  "QUERY PLAN": Array<{ Plan: PlanNode }>;
};

const db = getDb();
const APP_URL = "https://seo.example/base";

async function upsertSiteSettings() {
  await db
    .insert(siteSettings)
    .values([
      { key: "site_name", valueJson: "SEO Site", updatedAt: new Date("2026-07-09T00:00:00Z") },
      { key: "artist_name", valueJson: "SEO Artist", updatedAt: new Date("2026-07-09T00:00:00Z") },
      {
        key: "artist_bio",
        valueJson: "SEO public site bio",
        updatedAt: new Date("2026-07-09T00:00:00Z"),
      },
    ])
    .onConflictDoNothing();
}

async function seedFile(id: string, originalName = "secret-cover.png") {
  await db.insert(files).values({
    id,
    storageDriver: "local",
    objectKey: `files/${id}`,
    originalName,
    mimeType: "image/png",
    sizeBytes: 123,
    purpose: "cover",
  });
}

async function seedTier(id: string) {
  await db.insert(membershipTiers).values({
    id,
    name: "Secret Tier Name",
    slug: "secret-tier",
    priceLabel: "$9",
    level: 10,
    durationDays: 31,
    sortOrder: 1,
    isActive: true,
    purchaseEnabled: true,
  });
}

async function seedCategoryAndTag(postId: string) {
  await db.insert(categories).values({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Secret Category Name",
    slug: "secret-category",
  });
  await db.insert(tags).values({
    id: "22222222-2222-4222-8222-222222222222",
    name: "Secret Tag Name",
    slug: "secret-tag",
  });
  await db.insert(postCategories).values({
    postId,
    categoryId: "11111111-1111-4111-8111-111111111111",
  });
  await db.insert(postTags).values({
    postId,
    tagId: "22222222-2222-4222-8222-222222222222",
  });
}

async function seedPost(input: {
  id: string;
  slug: string;
  title: string;
  summary?: string | null;
  visibility?: "public" | "login" | "member";
  status?: "draft" | "published" | "archived";
  publishedAt?: string;
  updatedAt?: string;
  contentUpdatedAt?: string;
  body?: string | null;
  coverFileId?: string | null;
  requiredTierId?: string | null;
}) {
  const status = input.status ?? "published";
  await db.execute(sql`
    insert into posts (
      id,
      title,
      slug,
      summary,
      body,
      original_locale,
      cover_file_id,
      visibility,
      required_tier_id,
      status,
      published_at,
      content_updated_at,
      updated_at
    ) values (
      ${input.id}::uuid,
      ${input.title},
      ${input.slug},
      ${input.summary ?? null},
      ${input.body ?? null},
      'en',
      ${input.coverFileId ?? null}::uuid,
      ${input.visibility ?? "public"},
      ${input.requiredTierId ?? null}::uuid,
      ${status},
      ${status === "published" ? sql`${input.publishedAt ?? "2026-07-10T12:00:00.000Z"}::timestamptz` : sql`null`},
      ${input.contentUpdatedAt ?? input.updatedAt ?? input.publishedAt ?? "2026-07-10T12:00:00.000Z"}::timestamptz,
      ${input.updatedAt ?? input.publishedAt ?? "2026-07-10T12:00:00.000Z"}::timestamptz
    )
  `);
}

async function seedTranslation(input: {
  id: string;
  postId: string;
  title: string;
  summary?: string | null;
  status?: "draft" | "published" | "archived";
  updatedAt?: string;
  publishedAt?: string | null;
}) {
  const status = input.status ?? "published";
  await db.insert(postTranslations).values({
    id: input.id,
    postId: input.postId,
    locale: "zh",
    title: input.title,
    summary: input.summary ?? null,
    body: null,
    status,
    source: "manual",
    updatedAt: new Date(input.updatedAt ?? "2026-07-10T12:05:00.000Z"),
    publishedAt:
      status === "published" ? new Date(input.publishedAt ?? "2026-07-10T12:05:00.000Z") : null,
  });
}

function findPlanPath(plan: PlanNode, predicate: (node: PlanNode) => boolean): PlanNode[] | null {
  if (predicate(plan)) return [plan];
  for (const child of plan.Plans ?? []) {
    const path = findPlanPath(child, predicate);
    if (path) return [plan, ...path];
  }
  return null;
}

function metadataText(value: unknown): string {
  return JSON.stringify(value);
}

describeWithDatabase("public projection SEO integration", () => {
  beforeEach(async () => {
    process.env.APP_URL = APP_URL;
    await resetDatabase(db);
    await upsertSiteSettings();
  });

  it("keeps sitemap/index/shards public-only and stable across crawler headers", async () => {
    const restrictedCoverId = "33333333-3333-4333-8333-333333333333";
    await seedFile(restrictedCoverId);
    await seedTier("44444444-4444-4444-8444-444444444444");
    await seedPost({
      id: "00000000-0000-4000-8000-000000000001",
      slug: "public-one",
      title: "Public One",
      summary: "Public Summary",
      publishedAt: "2026-07-10T12:00:03.000Z",
    });
    await seedTranslation({
      id: "00000000-0000-4000-8000-000000000101",
      postId: "00000000-0000-4000-8000-000000000001",
      title: "公开中文标题",
      summary: "公开中文摘要",
    });
    await seedPost({
      id: "00000000-0000-4000-8000-000000000002",
      slug: "login-secret-slug",
      title: "Login Secret Title",
      summary: "Login Secret Summary",
      body: "Login Secret Body",
      visibility: "login",
      coverFileId: restrictedCoverId,
      publishedAt: "2026-07-10T12:00:02.000Z",
    });
    await seedPost({
      id: "00000000-0000-4000-8000-000000000003",
      slug: "member-secret-slug",
      title: "Member Secret Title",
      summary: "Member Secret Summary",
      body: "Member Secret Body",
      visibility: "member",
      requiredTierId: "44444444-4444-4444-8444-444444444444",
      publishedAt: "2026-07-10T12:00:01.000Z",
    });
    await seedCategoryAndTag("00000000-0000-4000-8000-000000000003");
    await seedPost({
      id: "00000000-0000-4000-8000-000000000004",
      slug: "draft-secret-slug",
      title: "Draft Secret Title",
      status: "draft",
    });

    const [indexZh, indexJa] = await Promise.all([
      sitemapIndexGET(
        new Request(`${APP_URL}/sitemap.xml`, {
          headers: { cookie: "locale=zh", "accept-language": "zh" },
        }) as never,
      ),
      sitemapIndexGET(
        new Request(`${APP_URL}/sitemap.xml`, {
          headers: { cookie: "locale=ja", "accept-language": "ja" },
        }) as never,
      ),
    ]);
    const indexXml = await indexZh.text();
    const indexJaXml = await indexJa.text();
    const shardResponse = await postShardGET(
      new Request(`${APP_URL}/sitemaps/posts/0.xml`) as never,
      {
        params: Promise.resolve({ shard: "0.xml" }),
      },
    );
    const shardXml = await shardResponse.text();

    expect(indexXml).toBe(indexJaXml);
    expect(indexZh.headers.get("etag")).toBe(indexJa.headers.get("etag"));
    expect(indexXml).toContain(`${APP_URL}/sitemaps/static.xml`);
    expect(indexXml).toContain(`${APP_URL}/sitemaps/posts/0.xml`);
    expect(indexXml).not.toContain("posts/1.xml");
    expect(shardXml).toContain(`${APP_URL}/posts/public-one`);
    expect(shardXml).not.toContain("login-secret-slug");
    expect(shardXml).not.toContain("member-secret-slug");
    expect(shardXml).not.toContain("draft-secret-slug");
    for (const privateValue of [
      "Login Secret Title",
      "Login Secret Summary",
      "Login Secret Body",
      "Member Secret Title",
      "Member Secret Summary",
      "Member Secret Body",
      "Draft Secret Title",
      restrictedCoverId,
      "Secret Category Name",
      "Secret Tag Name",
      "Secret Tier Name",
      "/download/",
    ]) {
      expect(indexXml).not.toContain(privateValue);
      expect(shardXml).not.toContain(privateValue);
    }
    expect(shardResponse.headers.get("set-cookie")).toBeNull();
    expect(shardResponse.headers.get("vary")).toBeNull();
  });

  it("advertises no post shards and 404s shard 0 when no public posts exist", async () => {
    const indexResponse = await sitemapIndexGET(new Request(`${APP_URL}/sitemap.xml`) as never);
    const indexXml = await indexResponse.text();
    const shardResponse = await postShardGET(
      new Request(`${APP_URL}/sitemaps/posts/0.xml`) as never,
      { params: Promise.resolve({ shard: "0.xml" }) },
    );

    expect(indexResponse.status).toBe(200);
    expect(indexXml).toContain(`${APP_URL}/sitemaps/static.xml`);
    expect(indexXml).not.toContain("posts/0.xml");
    expect(shardResponse.status).toBe(404);
  });

  it("walks shards by keyset pages and rejects out-of-range shards", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await seedPost({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        slug: `shard-post-${index}`,
        title: `Shard Post ${index}`,
        publishedAt: `2026-07-10T12:00:0${index}.000Z`,
      });
    }

    expect(countPublicSitemapPostShards(await countPublicPosts(), 2)).toBe(3);
    await expect(listPublicSitemapShard({ shard: 0, shardSize: 2 })).resolves.toHaveLength(2);
    await expect(listPublicSitemapShard({ shard: 1, shardSize: 2 })).resolves.toHaveLength(2);
    await expect(listPublicSitemapShard({ shard: 2, shardSize: 2 })).resolves.toHaveLength(1);
    await expect(
      buildSitemapIndexResource({ baseUrl: APP_URL, shardSize: 2 }),
    ).resolves.toMatchObject({
      body: expect.stringContaining(`${APP_URL}/sitemaps/posts/2.xml`),
    });
    await expect(
      buildPostSitemapShardResource({ baseUrl: APP_URL, shard: 3, shardSize: 2 }),
    ).resolves.toBeNull();
  });

  it("uses the public partial index without offset or unbounded pre-limit sort", async () => {
    for (let index = 1; index <= 10; index += 1) {
      await seedPost({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        slug: `plan-post-${index}`,
        title: `Plan ${index}`,
        publishedAt: `2026-07-10T12:00:${String(index).padStart(2, "0")}.000Z`,
      });
    }

    // Refresh planner statistics so the plan shape is deterministic even when
    // earlier suites churned the posts table in the same database.
    await db.execute(sql`analyze posts`);

    // EXPLAIN the real projection query (translation join and keyset cursor
    // included), for both the first page and a cursor page.
    const cursorCases = [
      null,
      { publishedAt: "2026-07-10T12:00:05.000Z", id: "00000000-0000-4000-8000-000000000005" },
    ];
    for (const cursor of cursorCases) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const query = publicPostProjectionQuery({ limit: 2, cursor, dbc: tx });
        const rows = await tx.execute<ExplainRow>(
          sql`explain (analyze, format json, costs off, timing off, summary off) ${query}`,
        );
        const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
        const pathToIndexScan = findPlanPath(
          plan,
          (node) => node["Index Name"] === "posts_public_feed_idx",
        );

        expect(pathToIndexScan).not.toBeNull();
        const limitIndex = pathToIndexScan!.findLastIndex((node) => node["Node Type"] === "Limit");
        expect(limitIndex).toBeGreaterThanOrEqual(0);
        for (const node of pathToIndexScan!.slice(limitIndex + 1)) {
          expect(node["Node Type"]).not.toBe("Sort");
        }
      });
    }
  });

  it("renders public metadata and keeps non-public metadata generic noindex without images", async () => {
    const coverId = "55555555-5555-4555-8555-555555555555";
    await seedFile(coverId, "public-cover.png");
    await seedTier("66666666-6666-4666-8666-666666666666");
    await seedPost({
      id: "00000000-0000-4000-8000-000000000010",
      slug: "public-meta",
      title: "Public Meta Title",
      summary: "Public Meta Summary",
      coverFileId: coverId,
      publishedAt: "2026-07-10T12:00:00.000Z",
    });
    await seedPost({
      id: "00000000-0000-4000-8000-000000000011",
      slug: "member-meta-secret",
      title: "Member Metadata Secret Title",
      summary: "Member Metadata Secret Summary",
      visibility: "member",
      requiredTierId: "66666666-6666-4666-8666-666666666666",
      coverFileId: coverId,
      publishedAt: "2026-07-10T12:00:01.000Z",
    });
    await seedCategoryAndTag("00000000-0000-4000-8000-000000000011");

    const publicMetadata = await buildPublicPostMetadata("public-meta");
    const memberMetadata = await buildPublicPostMetadata("member-meta-secret");
    const publicText = metadataText(publicMetadata);
    const memberText = metadataText(memberMetadata);

    expect(publicMetadata.title).toBe("Public Meta Title");
    expect(publicText).toContain("Public Meta Summary");
    expect(publicText).toContain(`${APP_URL}/posts/public-meta`);
    expect(publicText).toContain('"card":"summary"');
    expect(publicText).not.toContain("images");
    expect(publicText).not.toContain(coverId);

    expect(memberMetadata.title).toEqual({ absolute: "SEO Site" });
    expect(memberMetadata.robots).toEqual({ index: false, follow: false });
    expect(memberText).toContain(`${APP_URL}/posts/member-meta-secret`);
    expect(memberText).toContain('"card":"summary"');
    expect(memberText).not.toContain("images");
    for (const privateValue of [
      "Member Metadata Secret Title",
      "Member Metadata Secret Summary",
      coverId,
      "Secret Category Name",
      "Secret Tag Name",
      "Secret Tier Name",
    ]) {
      expect(memberText).not.toContain(privateValue);
    }
  });
});
