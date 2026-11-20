import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { canEnterInside } from "@/modules/blog/access";
import { getBlogCopy } from "@/modules/blog/copy";
import { requireInsidePage } from "@/modules/blog/reader-page";
import { listPublishedPostsPage, localizePostCards } from "@/modules/content";
import { getT, resolveLocale } from "@/modules/i18n/server";
import { BlogSearch, ReaderCard } from "@/themes/blog/personal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function InsidePage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; q?: string }>;
}) {
  const user = await requireInsidePage("/inside", false);
  if (!(await canEnterInside(user))) redirect("/inside/me");
  const { cursor, q } = await searchParams;
  const search = typeof q === "string" ? q.trim().slice(0, 120) : "";
  const [locale, t] = await Promise.all([resolveLocale(), getT()]);
  const page = await listPublishedPostsPage({
    audience: "inside",
    cursor,
    search,
    searchLocale: locale,
  });
  const copy = getBlogCopy(locale);
  const next = new URLSearchParams();
  if (page.nextCursor) next.set("cursor", page.nextCursor);
  if (search) next.set("q", search);
  const posts = await localizePostCards(page.posts, locale);
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="border-b pb-4 text-3xl font-bold tracking-tight">{copy.inside}</h1>
      <div className="my-5">
        <BlogSearch copy={copy} value={search} action="/inside" />
      </div>
      {posts.map((post) => (
        <ReaderCard
          key={post.slug}
          title={post.title}
          summary={post.summary}
          date={post.publishedAt}
          href={`/inside/posts/${post.slug}`}
        />
      ))}
      {!posts.length && <p className="py-8 text-sm text-muted-foreground">{t("posts.empty")}</p>}
      {page.nextCursor && (
        <Link href={`/inside?${next}`} className="inline-block py-4 underline">
          {t("posts.nextPage")}
        </Link>
      )}
    </section>
  );
}
