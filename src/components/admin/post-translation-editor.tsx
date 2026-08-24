"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { MarkdownEditor } from "@/components/admin/markdown-editor";
import {
  editableTranslation,
  hasPublishableTitle,
  type TranslationEditorStatus,
  translationEditorStatus,
  translationLocales,
  type TranslationVersion,
  translationVersionsForLocale,
} from "@/components/admin/post-translation-editor-model";
import { FormField, Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, uploadFile } from "@/lib/client";
import { type Locale, LOCALE_NAMES, SUPPORTED_LOCALES } from "@/modules/i18n/config";

type TranslationOverview = {
  post: {
    id: string;
    originalLocale: string;
    title: string;
    summary: string | null;
    body: string | null;
  };
  availableLocales: Locale[];
  translations: TranslationVersion[];
};

const STATUS_KEYS: Record<TranslationEditorStatus, string> = {
  untranslated: "admin.posts.translationUntranslated",
  draft: "admin.posts.translationDraft",
  published: "admin.posts.translationPublishedStatus",
  machineDraft: "admin.posts.translationMachineDraft",
};

const MOBILE_ACTION_CLASS = "w-full sm:w-auto";

export function PostTranslationEditor({
  postId,
  originalLocale,
  onDirtyChange,
}: {
  postId: string;
  originalLocale: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useT();
  const locales = useMemo(
    () => translationLocales(SUPPORTED_LOCALES, originalLocale),
    [originalLocale],
  );
  const [locale, setLocale] = useState<Locale>(locales[0] ?? "en");
  const [translations, setTranslations] = useState<TranslationVersion[]>([]);
  const [form, setForm] = useState({ title: "", summary: "", body: "" });
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(form));
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const versions = useMemo(
    () => translationVersionsForLocale(translations, locale),
    [locale, translations],
  );
  const status = translationEditorStatus(versions);
  const currentSnapshot = useMemo(() => JSON.stringify(form), [form]);
  const dirty = currentSnapshot !== savedSnapshot;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const replaceForm = useCallback((nextForm: typeof form) => {
    setForm(nextForm);
    setSavedSnapshot(JSON.stringify(nextForm));
  }, []);

  async function load(preferredLocale = locale) {
    const overview = await api<TranslationOverview>(`/api/admin/posts/${postId}/translations`);
    const available = translationLocales(SUPPORTED_LOCALES, overview.post.originalLocale);
    const nextLocale = available.includes(preferredLocale) ? preferredLocale : available[0];
    if (!nextLocale) return;
    setTranslations(overview.translations);
    setLocale(nextLocale);
    replaceForm(
      editableTranslation(translationVersionsForLocale(overview.translations, nextLocale)),
    );
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    api<TranslationOverview>(`/api/admin/posts/${postId}/translations`)
      .then((overview) => {
        if (!active) return;
        const available = translationLocales(SUPPORTED_LOCALES, overview.post.originalLocale);
        const nextLocale = available[0];
        setTranslations(overview.translations);
        if (nextLocale) {
          setLocale(nextLocale);
          replaceForm(
            editableTranslation(translationVersionsForLocale(overview.translations, nextLocale)),
          );
        }
      })
      .catch((err) => {
        if (active) {
          setMessage(err instanceof Error ? err.message : t("admin.posts.translationLoadFailed"));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [postId, replaceForm, t]);

  function selectLocale(nextLocale: Locale) {
    if (dirty && !window.confirm(t("admin.posts.unsavedChangesConfirm"))) return;
    setLocale(nextLocale);
    setMessage(null);
    replaceForm(editableTranslation(translationVersionsForLocale(translations, nextLocale)));
  }

  async function run(action: () => Promise<void>) {
    setLoading(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function uploadInlineImage(file: File): Promise<string> {
    const record = await uploadFile<{ id: string }>("/api/admin/files/upload", file, {
      purpose: "content_image",
    });
    return `/api/files/${record.id}/download`;
  }

  async function saveDraft() {
    await api(`/api/admin/posts/${postId}/translations`, {
      method: "PUT",
      body: {
        locale,
        title: form.title,
        summary: form.summary || null,
        body: form.body || null,
      },
    });
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("admin.posts.translations")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="break-words text-sm text-muted-foreground">
          {t("admin.posts.translationHelp", {
            locale: LOCALE_NAMES[originalLocale as Locale] ?? originalLocale,
          })}
        </p>
        <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 space-y-1 sm:min-w-48">
            <Label htmlFor="translation-locale">{t("admin.posts.translationLanguage")}</Label>
            <select
              id="translation-locale"
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              value={locale}
              onChange={(event) => selectLocale(event.target.value as Locale)}
              disabled={loading}
            >
              {locales.map((option) => (
                <option key={option} value={option}>
                  {LOCALE_NAMES[option]}
                </option>
              ))}
            </select>
          </div>
          <Badge className="self-start" variant={status === "published" ? "default" : "outline"}>
            {t(STATUS_KEYS[status])}
          </Badge>
        </div>

        <FormField id={`translation-title-${locale}`} label={t("admin.posts.translationTitle")}>
          <Input
            disabled={loading}
            value={form.title}
            onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
          />
        </FormField>
        <FormField id={`translation-summary-${locale}`} label={t("admin.posts.translationSummary")}>
          <Input
            disabled={loading}
            value={form.summary}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                summary: event.target.value,
              }))
            }
          />
        </FormField>
        <FormField id={`translation-body-${locale}`} label={t("admin.posts.translationBody")}>
          <MarkdownEditor
            id={`translation-body-${locale}`}
            value={form.body}
            onChange={(body) => setForm((current) => ({ ...current, body }))}
            onUploadImage={uploadInlineImage}
            disabled={loading}
            ariaLabel={t("admin.posts.translationBody")}
          />
        </FormField>

        {message && <Notice className="break-words [overflow-wrap:anywhere]">{message}</Notice>}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            className={MOBILE_ACTION_CLASS}
            disabled={loading}
            onClick={() =>
              run(async () => {
                await saveDraft();
                await load(locale);
                setMessage(t("admin.posts.translationDraftSaved"));
              })
            }
          >
            {t("admin.posts.saveTranslationDraft")}
          </Button>
          <Button
            className={MOBILE_ACTION_CLASS}
            variant="outline"
            disabled={loading || !hasPublishableTitle(form.title)}
            onClick={() =>
              run(async () => {
                if (!hasPublishableTitle(form.title)) {
                  setMessage(t("admin.posts.translationTitleRequired"));
                  return;
                }
                await saveDraft();
                await api(`/api/admin/posts/${postId}/translations/${locale}/publish`, {
                  method: "POST",
                });
                await load(locale);
                setMessage(t("admin.posts.translationPublished"));
              })
            }
          >
            {t("admin.posts.publishTranslation")}
          </Button>
          {versions.published && (
            <Button
              className={MOBILE_ACTION_CLASS}
              variant="outline"
              disabled={loading}
              onClick={() =>
                run(async () => {
                  if (dirty && !window.confirm(t("admin.posts.unsavedChangesConfirm"))) return;
                  await api(`/api/admin/posts/${postId}/translations/${locale}/unpublish`, {
                    method: "POST",
                  });
                  await load(locale);
                  setMessage(t("admin.posts.translationUnpublished"));
                })
              }
            >
              {t("admin.posts.unpublishTranslation")}
            </Button>
          )}
          {versions.draft && (
            <Button
              className={MOBILE_ACTION_CLASS}
              variant="destructive"
              disabled={loading}
              onClick={() =>
                run(async () => {
                  if (!confirm(t("admin.posts.confirmDiscardTranslationDraft"))) return;
                  await api(`/api/admin/posts/${postId}/translations/${locale}`, {
                    method: "DELETE",
                  });
                  await load(locale);
                  setMessage(t("admin.posts.translationDraftDiscarded"));
                })
              }
            >
              {t("admin.posts.discardTranslationDraft")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
