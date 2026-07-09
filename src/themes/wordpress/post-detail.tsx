import { Download, LockKeyhole } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { PostDetailView } from "@/modules/theme/types";
import { PostVisibilityBadge } from "@/themes/builtin/post-visibility-badge";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function DetailSidebar({ view, t }: { view: PostDetailView; t: Translate }) {
  return (
    <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">{t("theme.wordpress.postInfo")}</h2>
        <div className="mt-3 space-y-2 text-sm text-muted-foreground">
          {view.publishedAt && <p>{view.publishedAt.toISOString().slice(0, 10)}</p>}
          <PostVisibilityBadge visibility={view.visibility} t={t} />
          {view.machineTranslated && <Badge variant="outline">{t("post.machineTranslated")}</Badge>}
        </div>
      </section>
      {(view.categories.length > 0 || view.tags.length > 0) && (
        <section className="rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold">{t("theme.wordpress.thisPost")}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {view.categories.map((category) => (
              <Link
                key={category.slug}
                href={`/posts?category=${encodeURIComponent(category.slug)}`}
              >
                <Badge variant="secondary">{category.name}</Badge>
              </Link>
            ))}
            {view.tags.map((tag) => (
              <Link key={tag.slug} href={`/posts?tag=${encodeURIComponent(tag.slug)}`}>
                <Badge variant="outline">#{tag.name}</Badge>
              </Link>
            ))}
          </div>
        </section>
      )}
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">{t("home.supportPlans")}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("home.supportPlansHint")}</p>
        <Button asChild className="mt-4 w-full" variant="outline">
          <Link href="/tiers">{t("post.openMembership")}</Link>
        </Button>
      </section>
    </aside>
  );
}

export function PostDetail({ view, t }: { view: PostDetailView; t: Translate }) {
  const memberLabel =
    view.visibility === "member" && view.requiredTierName
      ? t("post.memberVisible", { tier: view.requiredTierName })
      : undefined;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <article className="min-w-0 overflow-hidden rounded-3xl border bg-card shadow-sm">
        <header className="space-y-4 border-b px-6 py-7 sm:px-8">
          <div className="flex flex-wrap items-center gap-2">
            <PostVisibilityBadge visibility={view.visibility} t={t} memberLabel={memberLabel} />
            {view.machineTranslated && (
              <Badge variant="outline">{t("post.machineTranslated")}</Badge>
            )}
            {view.publishedAt && (
              <time className="text-sm text-muted-foreground">
                {view.publishedAt.toISOString().slice(0, 10)}
              </time>
            )}
          </div>
          <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-5xl">
            {view.title}
          </h1>
          {view.summary && (
            <p className="max-w-3xl text-base leading-8 text-muted-foreground sm:text-lg">
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
                  <Badge variant="secondary">{category.name}</Badge>
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
          <img src={view.coverUrl} alt={view.title} className="max-h-[520px] w-full object-cover" />
        )}

        {!view.allowed ? (
          <section className="mx-6 my-8 rounded-2xl border bg-muted/40 px-6 py-10 text-center sm:mx-8">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-background text-primary shadow-sm">
              <LockKeyhole className="size-5" />
            </div>
            <h2 className="mt-4 text-xl font-semibold">{t("post.lockedTitle")}</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              {view.visibility === "login"
                ? t("post.lockedLogin")
                : t("post.lockedMember", {
                    tier: view.requiredTierName ?? t("post.memberFallback"),
                  })}
            </p>
            <Button asChild className="mt-5">
              <a href={view.isLoggedIn ? "/tiers" : "/login"}>
                {view.isLoggedIn ? t("post.openMembership") : t("post.goLogin")}
              </a>
            </Button>
          </section>
        ) : (
          <div className="space-y-9 px-6 py-8 sm:px-8">
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
                    className="w-full rounded-2xl border shadow-sm"
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
                <div className="space-y-3">
                  {view.attachments.map((att) => (
                    <div
                      key={att.downloadHref}
                      className="space-y-3 rounded-2xl border bg-background p-4"
                    >
                      {att.inlineCandidate && att.playHref && (
                        <video
                          className="inline-video-player"
                          controls
                          preload="metadata"
                          playsInline
                          src={att.playHref}
                          aria-label={t("post.playVideo")}
                        >
                          {t("post.videoUnsupported")}
                        </video>
                      )}
                      <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">
                          {att.name}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {formatSize(att.sizeBytes)}
                          </span>
                        </span>
                        <Button size="sm" variant="outline" className="shrink-0" asChild>
                          <a href={att.downloadHref}>
                            <Download className="size-4" />
                            {att.inlineCandidate ? t("post.downloadVideo") : t("post.download")}
                          </a>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </article>
      <DetailSidebar view={view} t={t} />
    </div>
  );
}
