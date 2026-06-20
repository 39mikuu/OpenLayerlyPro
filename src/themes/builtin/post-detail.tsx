import { Download, LockKeyhole } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { PostDetailView } from "@/modules/theme/types";

import { PostVisibilityBadge } from "./post-visibility-badge";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function PostDetail({ view, t }: { view: PostDetailView; t: Translate }) {
  const memberLabel =
    view.visibility === "member" && view.requiredTierName
      ? t("post.memberVisible", { tier: view.requiredTierName })
      : undefined;

  return (
    <article className="mx-auto max-w-3xl">
      <header className="space-y-4 border-b pb-7">
        <div className="flex flex-wrap items-center gap-2">
          <PostVisibilityBadge visibility={view.visibility} t={t} memberLabel={memberLabel} />
          {view.machineTranslated && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {t("post.machineTranslated")}
            </Badge>
          )}
          {view.publishedAt && (
            <time className="text-sm text-muted-foreground">
              {view.publishedAt.toISOString().slice(0, 10)}
            </time>
          )}
        </div>

        <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          {view.title}
        </h1>
        {view.summary && (
          <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            {view.summary}
          </p>
        )}
        {(view.categories.length > 0 || view.tags.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {view.categories.map((category) => (
              <Link
                key={category.slug}
                href={`/posts?category=${encodeURIComponent(category.slug)}`}
              >
                <Badge>{category.name}</Badge>
              </Link>
            ))}
            {view.tags.map((tag) => (
              <Link key={tag.slug} href={`/posts?tag=${encodeURIComponent(tag.slug)}`}>
                <Badge variant="outline">#{tag.name}</Badge>
              </Link>
            ))}
          </div>
        )}
      </header>

      {view.coverUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={view.coverUrl}
          alt={view.title}
          className="mt-7 w-full rounded-xl border object-cover shadow-sm"
        />
      )}

      {!view.allowed ? (
        <section className="mt-8 rounded-xl border border-blue-100 bg-blue-50/60 px-6 py-8 text-center dark:border-blue-900 dark:bg-blue-950/20 sm:px-10">
          <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-background text-primary shadow-sm">
            <LockKeyhole className="size-5" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">{t("post.lockedTitle")}</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
            {view.visibility === "login"
              ? t("post.lockedLogin")
              : t("post.lockedMember", {
                  tier: view.requiredTierName ?? t("post.memberFallback"),
                })}
          </p>
          <Button asChild className="mt-5">
            <Link href={view.isLoggedIn ? "/tiers" : "/login"}>
              {view.isLoggedIn ? t("post.openMembership") : t("post.goLogin")}
            </Link>
          </Button>
        </section>
      ) : (
        <div className="mt-8 space-y-9">
          {view.bodyHtml && (
            <div
              className="prose-content text-[15px] leading-8 sm:text-base"
              dangerouslySetInnerHTML={{ __html: view.bodyHtml }}
            />
          )}

          {view.images.length > 0 && (
            <div className="space-y-5">
              {view.images.map((img) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={img.url}
                  src={img.url}
                  alt={img.alt}
                  className="w-full rounded-xl border shadow-sm"
                />
              ))}
            </div>
          )}

          {view.attachments.length > 0 && (
            <section className="space-y-3 border-t pt-7">
              <div>
                <h2 className="font-semibold">{t("post.attachments")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("post.attachmentsHint")}</p>
              </div>
              <div className="space-y-2">
                {view.attachments.map((att) => (
                  <div
                    key={att.downloadHref}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {att.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatSize(att.sizeBytes)}
                      </span>
                    </span>
                    <Button size="sm" variant="outline" className="shrink-0" asChild>
                      <a href={att.downloadHref}>
                        <Download className="size-4" />
                        {t("post.download")}
                      </a>
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </article>
  );
}
