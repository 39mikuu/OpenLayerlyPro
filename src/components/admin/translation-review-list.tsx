"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import { type Locale, LOCALE_NAMES } from "@/modules/i18n";

type ReviewItem = {
  postId: string;
  postTitle: string;
  originalLocale: string;
  originalTitle: string;
  originalSummary: string | null;
  originalBody: string | null;
  postUpdatedAt: string;
  translationId: string;
  locale: string;
  title: string;
  summary: string | null;
  body: string | null;
  sourceUpdatedAt: string | null;
  translationUpdatedAt: string;
  stale: boolean;
};

function TranslationReviewCard({ item }: { item: ReviewItem }) {
  const router = useRouter();
  const t = useT();
  const [form, setForm] = useState({
    title: item.title,
    summary: item.summary ?? "",
    body: item.body ?? "",
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<void>, success: string) {
    setLoading(true);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function saveDraft() {
    await api(`/api/admin/posts/${item.postId}/translations`, {
      method: "PUT",
      body: {
        locale: item.locale,
        title: form.title,
        summary: form.summary || null,
        body: form.body || null,
        source: "machine",
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span>{item.postTitle}</span>
          <Badge variant="secondary">{LOCALE_NAMES[item.locale as Locale] ?? item.locale}</Badge>
          <Badge variant="outline">{t("admin.translations.machineDraft")}</Badge>
          {item.stale && <Badge variant="destructive">{t("admin.translations.stale")}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-3 rounded-md border p-4">
            <h2 className="font-medium">
              {t("admin.translations.original", {
                locale: LOCALE_NAMES[item.originalLocale as Locale] ?? item.originalLocale,
              })}
            </h2>
            <div>
              <p className="text-xs text-muted-foreground">{t("admin.posts.translationTitle")}</p>
              <p>{item.originalTitle}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("admin.posts.translationSummary")}</p>
              <p className="whitespace-pre-wrap">{item.originalSummary || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("admin.posts.translationBody")}</p>
              <p className="max-h-80 overflow-auto whitespace-pre-wrap text-sm">
                {item.originalBody || "—"}
              </p>
            </div>
          </section>
          <section className="space-y-3 rounded-md border p-4">
            <h2 className="font-medium">{t("admin.translations.translation")}</h2>
            <div className="space-y-1">
              <Label htmlFor={`review-title-${item.translationId}`}>
                {t("admin.posts.translationTitle")}
              </Label>
              <Input
                id={`review-title-${item.translationId}`}
                value={form.title}
                onChange={(event) =>
                  setForm((current) => ({ ...current, title: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`review-summary-${item.translationId}`}>
                {t("admin.posts.translationSummary")}
              </Label>
              <Textarea
                id={`review-summary-${item.translationId}`}
                rows={3}
                value={form.summary}
                onChange={(event) =>
                  setForm((current) => ({ ...current, summary: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`review-body-${item.translationId}`}>
                {t("admin.posts.translationBody")}
              </Label>
              <Textarea
                id={`review-body-${item.translationId}`}
                rows={12}
                value={form.body}
                onChange={(event) =>
                  setForm((current) => ({ ...current, body: event.target.value }))
                }
              />
            </div>
          </section>
        </div>
        <div className="text-xs text-muted-foreground">
          <p>
            {t("admin.translations.sourceUpdatedAt")}:{" "}
            {item.sourceUpdatedAt
              ? item.sourceUpdatedAt.replace("T", " ").slice(0, 16)
              : t("admin.common.none")}
          </p>
          {item.stale && <p>{t("admin.translations.staleHelp")}</p>}
        </div>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={loading}
            onClick={() => run(saveDraft, t("admin.posts.translationDraftSaved"))}
          >
            {t("admin.posts.saveTranslationDraft")}
          </Button>
          <Button
            variant="outline"
            disabled={loading || !form.title.trim()}
            onClick={() =>
              run(async () => {
                await saveDraft();
                await api(`/api/admin/posts/${item.postId}/translations/${item.locale}/publish`, {
                  method: "POST",
                });
              }, t("admin.posts.translationPublished"))
            }
          >
            {t("admin.posts.publishTranslation")}
          </Button>
          <Button
            variant="destructive"
            disabled={loading}
            onClick={() => {
              if (!confirm(t("admin.posts.confirmDiscardTranslationDraft"))) return;
              void run(
                () =>
                  api(`/api/admin/posts/${item.postId}/translations/${item.locale}`, {
                    method: "DELETE",
                  }),
                t("admin.posts.translationDraftDiscarded"),
              );
            }}
          >
            {t("admin.posts.discardTranslationDraft")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function TranslationReviewList({ items }: { items: ReviewItem[] }) {
  const t = useT();
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("admin.translations.empty")}</p>;
  }
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <TranslationReviewCard key={item.translationId} item={item} />
      ))}
    </div>
  );
}
