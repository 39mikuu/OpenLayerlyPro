import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { HomeView, PostCardView, TaxonomyLinkView } from "@/modules/theme/types";

function uniqueLinks(posts: PostCardView[], key: "categories" | "tags"): TaxonomyLinkView[] {
  const seen = new Map<string, TaxonomyLinkView>();
  for (const post of posts) {
    for (const item of post[key] ?? []) {
      if (!seen.has(item.slug)) seen.set(item.slug, item);
    }
  }
  return [...seen.values()];
}

export function AuthorSidebar({ view, t }: { view: HomeView; t: Translate }) {
  const creatorName = view.artistName || view.siteName;
  return (
    <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-3">
          {view.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={view.avatarUrl}
              alt={creatorName}
              className="size-14 shrink-0 rounded-full border object-cover"
            />
          ) : (
            <div className="grid size-14 shrink-0 place-items-center rounded-full border bg-muted text-lg font-bold text-primary">
              {creatorName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
              {t("theme.wordpress.classicBlog")}
            </p>
            <h2 className="truncate text-lg font-bold">{creatorName}</h2>
          </div>
        </div>
        {view.bio && (
          <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">
            {view.bio}
          </p>
        )}
        {view.socialLinks.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {view.socialLinks.map((link) => (
              <Button key={link.url} asChild size="sm" variant="outline">
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.name}
                </a>
              </Button>
            ))}
          </div>
        )}
      </section>

      {view.tiers.length > 0 && (
        <section className="rounded-2xl border bg-card p-5 shadow-sm">
          <p className="text-sm font-semibold">{t("home.supportPlans")}</p>
          <div className="mt-3 space-y-2">
            {view.tiers.slice(0, 3).map((tier) => (
              <div key={tier.id} className="rounded-xl border bg-background px-3 py-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{tier.name}</span>
                  <span className="text-xs text-muted-foreground">{tier.priceLabel}</span>
                </div>
              </div>
            ))}
          </div>
          <Button asChild className="mt-4 w-full">
            <Link href="/tiers">{t("home.becomeMember")}</Link>
          </Button>
        </section>
      )}
    </aside>
  );
}

export function ArchiveSidebar({ posts, t }: { posts: PostCardView[]; t: Translate }) {
  const categories = uniqueLinks(posts, "categories");
  const tags = uniqueLinks(posts, "tags");
  return (
    <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">{t("posts.title")}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("posts.subtitle")}</p>
        <Button asChild variant="outline" className="mt-4 w-full">
          <Link href="/tiers">{t("home.becomeMember")}</Link>
        </Button>
      </section>

      {categories.length > 0 && (
        <section className="rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold">{t("theme.wordpress.pageCategories")}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {categories.map((category) => (
              <Link
                key={category.slug}
                href={`/posts?category=${encodeURIComponent(category.slug)}`}
              >
                <Badge variant="secondary">{category.name}</Badge>
              </Link>
            ))}
          </div>
        </section>
      )}

      {tags.length > 0 && (
        <section className="rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold">{t("theme.wordpress.pageTags")}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Link key={tag.slug} href={`/posts?tag=${encodeURIComponent(tag.slug)}`}>
                <Badge variant="outline">#{tag.name}</Badge>
              </Link>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
