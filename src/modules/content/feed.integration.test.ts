import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.APP_URL = "https://feeds.example/base/";
});

import { GET } from "@/app/feed.xml/route";
import { getDb } from "@/db";
import { posts, postTranslations, siteSettings } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import {
  buildPostGuid,
  listPublicAtomFeedEntries,
  PUBLIC_ATOM_FEED_LIMIT,
  PUBLIC_ATOM_FEED_SQL,
  publicAtomFeedSqlText,
} from "@/modules/content/feed";
import { setSetting } from "@/modules/site";

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
const APP_URL = "https://feeds.example/base/";

function request(headers: HeadersInit = {}) {
  return new NextRequest("https://feeds.example/base/feed.xml", { headers });
}

async function upsertSiteSettings(siteName = "Feed Site", artistName = "Feed Artist") {
  await db
    .insert(siteSettings)
    .values([
      // Pin updatedAt so feed Last-Modified assertions are driven by the
      // timestamps each test controls, not the suite's wall-clock run time.
      { key: "site_name", valueJson: siteName, updatedAt: new Date("2026-07-09T00:00:00Z") },
      { key: "artist_name", valueJson: artistName, updatedAt: new Date("2026-07-09T00:00:00Z") },
    ])
    .onConflictDoNothing();
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

function entryIds(xml: string): string[] {
  return Array.from(xml.matchAll(/<entry>[\s\S]*?<id>([^<]+)<\/id>[\s\S]*?<\/entry>/g)).map(
    (match) => match[1]!,
  );
}

function entryLinks(xml: string): string[] {
  return Array.from(xml.matchAll(/<entry>[\s\S]*?<link rel="alternate" href="([^"]+)"\/>/g)).map(
    (match) => match[1]!,
  );
}

function findPlanPath(plan: PlanNode, predicate: (node: PlanNode) => boolean): PlanNode[] | null {
  if (predicate(plan)) return [plan];
  for (const child of plan.Plans ?? []) {
    const path = findPlanPath(child, predicate);
    if (path) return [plan, ...path];
  }
  return null;
}

describeWithDatabase("public Atom feed integration", () => {
  beforeEach(async () => {
    process.env.APP_URL = APP_URL;
    await resetDatabase(db);
    await upsertSiteSettings();
  });

  it("caps the feed at 100 public posts ordered by publishedAt desc and id desc", async () => {
    const timestamp = "2026-07-10T12:00:00.000Z";
    for (let index = 1; index <= 101; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      await seedPost({
        id,
        slug: `post-${index}`,
        title: `Post ${index}`,
        publishedAt: timestamp,
      });
    }

    const entries = await listPublicAtomFeedEntries();

    expect(entries).toHaveLength(PUBLIC_ATOM_FEED_LIMIT);
    expect(entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => {
        const numeric = 101 - index;
        return `00000000-0000-4000-8000-${String(numeric).padStart(12, "0")}`;
      }),
    );
  });

  it("excludes non-public and unpublished content without leaking restricted fields into XML", async () => {
    const restrictedCoverId = "33333333-3333-4333-8333-333333333333";
    await seedPost({
      id: "00000000-0000-4000-8000-000000000001",
      slug: "public-post",
      title: "Public title",
      summary: "Public summary",
      body: "Public body",
    });
    await seedPost({
      id: "00000000-0000-4000-8000-000000000002",
      slug: "login-secret-slug",
      title: "Login Secret Title",
      summary: "Login Secret Summary",
      body: `Login Secret Body /download/${restrictedCoverId}`,
      visibility: "login",
    });
    await seedPost({
      id: "00000000-0000-4000-8000-000000000003",
      slug: "member-secret-slug",
      title: "Member Secret Title",
      summary: "Member Secret Summary",
      body: "Member Secret Body",
      visibility: "member",
    });
    await seedPost({
      id: "00000000-0000-4000-8000-000000000004",
      slug: "draft-secret-slug",
      title: "Draft Secret Title",
      status: "draft",
    });
    await seedPost({
      id: "00000000-0000-4000-8000-000000000005",
      slug: "archived-secret-slug",
      title: "Archived Secret Title",
      status: "archived",
    });

    const response = await GET(request());
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain("Public title");
    for (const privateValue of [
      "Login Secret Title",
      "Login Secret Summary",
      "Login Secret Body",
      "login-secret-slug",
      "Member Secret Title",
      "Member Secret Summary",
      "member-secret-slug",
      "Draft Secret Title",
      "draft-secret-slug",
      "Archived Secret Title",
      "archived-secret-slug",
      restrictedCoverId,
      "/download/",
    ]) {
      expect(xml).not.toContain(privateValue);
    }
  });

  it("projects only published DEFAULT_LOCALE translations and invalidates when projection changes", async () => {
    const postId = "00000000-0000-4000-8000-000000000010";
    await seedPost({
      id: postId,
      slug: "translated-post",
      title: "Original Title",
      summary: "Original Summary",
      publishedAt: "2026-07-10T12:00:00.000Z",
    });
    await seedTranslation({
      id: "00000000-0000-4000-8000-000000000011",
      postId,
      title: "中文标题",
      summary: "中文摘要",
      publishedAt: "2026-07-10T12:00:01.100Z",
      updatedAt: "2026-07-10T12:00:01.100Z",
    });
    await seedTranslation({
      id: "00000000-0000-4000-8000-000000000012",
      postId,
      title: "草稿标题",
      summary: "草稿摘要",
      status: "draft",
      publishedAt: null,
    });

    const translated = await GET(request());
    const translatedXml = await translated.text();
    const translatedEtag = translated.headers.get("etag");

    expect(translatedXml).toContain("中文标题");
    expect(translatedXml).toContain("中文摘要");
    expect(translatedXml).not.toContain("Original Title");
    expect(translatedXml).not.toContain("草稿标题");

    await db
      .update(postTranslations)
      .set({
        title: "更新后中文标题",
        summary: "更新后中文摘要",
        updatedAt: new Date("2026-07-10T12:00:02.500Z"),
      })
      .where(sql`${postTranslations.id} = '00000000-0000-4000-8000-000000000011'::uuid`);
    const changed = await GET(request());
    expect(changed.headers.get("etag")).not.toBe(translatedEtag);
    await expect(changed.text()).resolves.toContain("更新后中文标题");

    await db
      .update(postTranslations)
      .set({ status: "archived", updatedAt: new Date("2026-07-10T12:00:03.000Z") })
      .where(sql`${postTranslations.id} = '00000000-0000-4000-8000-000000000011'::uuid`);
    const fallback = await GET(request());
    const fallbackXml = await fallback.text();
    expect(fallback.headers.get("etag")).not.toBe(changed.headers.get("etag"));
    expect(fallbackXml).toContain("Original Title");
    expect(fallbackXml).not.toContain("更新后中文标题");
  });

  it("keeps entry GUID stable when the slug changes but updates the canonical link", async () => {
    const postId = "00000000-0000-4000-8000-000000000020";
    await seedPost({
      id: postId,
      slug: "first-slug",
      title: "Stable GUID",
    });

    const firstXml = await (await GET(request())).text();
    await db
      .update(posts)
      .set({ slug: "second-slug" })
      .where(sql`${posts.id} = ${postId}::uuid`);
    const secondXml = await (await GET(request())).text();

    expect(entryIds(firstXml)).toEqual([buildPostGuid(postId)]);
    expect(entryIds(secondXml)).toEqual([buildPostGuid(postId)]);
    expect(entryLinks(firstXml)).toEqual(["https://feeds.example/base/posts/first-slug"]);
    expect(entryLinks(secondXml)).toEqual(["https://feeds.example/base/posts/second-slug"]);
  });

  it("is byte-identical across Cookie and Accept-Language and supports conditional 304s", async () => {
    await seedPost({
      id: "00000000-0000-4000-8000-000000000030",
      slug: "conditional",
      title: "Conditional",
      updatedAt: "2026-07-10T12:00:00.900Z",
      contentUpdatedAt: "2026-07-10T12:00:00.900Z",
    });

    const zh = await GET(request({ cookie: "locale=zh", "accept-language": "zh" }));
    const ja = await GET(request({ cookie: "locale=ja", "accept-language": "ja" }));
    const zhXml = await zh.text();
    const jaXml = await ja.text();

    expect(zhXml).toBe(jaXml);
    expect(zh.headers.get("etag")).toBe(ja.headers.get("etag"));
    expect(zh.headers.get("set-cookie")).toBeNull();
    expect(zh.headers.get("vary")).toBeNull();

    const etag304 = await GET(request({ "if-none-match": zh.headers.get("etag")! }));
    expect(etag304.status).toBe(304);
    expect(etag304.headers.get("set-cookie")).toBeNull();
    expect(etag304.headers.get("vary")).toBeNull();

    const earlySameSecond = await GET(
      request({ "if-modified-since": "Fri, 10 Jul 2026 12:00:00 GMT" }),
    );
    expect(earlySameSecond.status).toBe(200);

    const ims304 = await GET(request({ "if-modified-since": "Fri, 10 Jul 2026 12:00:01 GMT" }));
    expect(ims304.status).toBe(304);
  });

  it("advances Last-Modified when public feed identity settings change", async () => {
    await seedPost({
      id: "00000000-0000-4000-8000-000000000040",
      slug: "site-settings-validator",
      title: "Site settings validator",
      updatedAt: "2026-07-10T12:00:00.000Z",
      contentUpdatedAt: "2026-07-10T12:00:00.000Z",
    });

    await setSetting("site_name", "Before settings change");
    await db.execute(
      sql`update site_settings set updated_at = '2026-07-10T12:00:02Z'::timestamptz where key = 'site_name'`,
    );
    const before = await GET(request());
    const beforeLastModified = before.headers.get("last-modified");
    expect(beforeLastModified).toBe("Fri, 10 Jul 2026 12:00:02 GMT");

    await setSetting("site_name", "After settings change");
    await db.execute(
      sql`update site_settings set updated_at = '2026-07-10T12:00:03Z'::timestamptz where key = 'site_name'`,
    );
    const after = await GET(request());

    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    expect(after.headers.get("last-modified")).toBe("Fri, 10 Jul 2026 12:00:03 GMT");
    expect(Date.parse(after.headers.get("last-modified")!)).toBeGreaterThan(
      Date.parse(beforeLastModified!),
    );
    await expect(after.text()).resolves.toContain("After settings change");

    const staleIms = await GET(request({ "if-modified-since": beforeLastModified! }));
    expect(staleIms.status).toBe(200);
  });

  it("uses the public feed partial index without offset or unbounded pre-limit sort", async () => {
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

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = await tx.execute<ExplainRow>(sql`
        explain (format json, costs off)
        ${PUBLIC_ATOM_FEED_SQL}
      `);
      const plan = rows[0]!["QUERY PLAN"][0]!.Plan;

      expect(publicAtomFeedSqlText()).not.toMatch(/\boffset\b/i);

      // The plan must reach the partial index through a Limit with no Sort in
      // between: the top-100 subquery is satisfied by index order, never by
      // sorting an unbounded scan. Exact node adjacency is planner-dependent
      // (joins can sit between Limit and the scan), so assert on the path.
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
  });
});
