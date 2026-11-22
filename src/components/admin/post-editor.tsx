"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { MarkdownEditor } from "@/components/admin/markdown-editor";
import { PostTranslationEditor } from "@/components/admin/post-translation-editor";
import { FormField, Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, uploadFile, uploadStreamFile } from "@/lib/client";
import type { getBlogCopy } from "@/modules/blog/copy";
import { canReadPostAudience } from "@/modules/content/audience";

type TierOption = { id: string; name: string; level: number };
type TaxonomyOption = { id: string; name: string };

type PostData = {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  body: string | null;
  coverFileId: string | null;
  visibility: "public" | "login" | "member";
  requiredTierId: string | null;
  status: string;
  originalLocale: string;
};

type AttachedFile = {
  fileId: string;
  kind: string;
  originalName: string;
  sizeBytes: number;
};

type EditablePostForm = {
  body: string;
  coverFileId: string | null;
  requiredTierId: string;
  slug: string;
  summary: string;
  title: string;
  visibility: "public" | "login" | "member";
};

const FILE_INPUT_CLASS = "h-auto min-h-8 max-w-full py-1 file:mr-2 file:max-w-full";
const MOBILE_ACTION_CLASS = "w-full sm:w-auto";

function formSnapshot(form: EditablePostForm): string {
  return JSON.stringify({
    ...form,
    requiredTierId: form.visibility === "member" ? form.requiredTierId : "",
  });
}

function taxonomySnapshot(categoryIds: string[], tagIds: string[]): string {
  return JSON.stringify({ categoryIds: [...categoryIds].sort(), tagIds: [...tagIds].sort() });
}

export function PostEditor({
  post,
  tiers,
  attachedFiles,
  categories,
  tags,
  selectedCategoryIds,
  selectedTagIds,
  blogCopy,
}: {
  post: PostData | null;
  tiers: TierOption[];
  attachedFiles: AttachedFile[];
  categories: TaxonomyOption[];
  tags: TaxonomyOption[];
  selectedCategoryIds: string[];
  selectedTagIds: string[];
  blogCopy?: ReturnType<typeof getBlogCopy>;
}) {
  const router = useRouter();
  const t = useT();
  const [previewAudience, setPreviewAudience] = useState("owner");
  const isNew = !post;
  const isPublished = post?.status === "published";
  const [form, setForm] = useState<EditablePostForm>({
    title: post?.title ?? "",
    slug: post?.slug ?? "",
    summary: post?.summary ?? "",
    body: post?.body ?? "",
    visibility: post?.visibility ?? "public",
    requiredTierId: post?.requiredTierId ?? "",
    coverFileId: post?.coverFileId ?? null,
  });
  const previewTier = tiers.find((tier) => tier.id === previewAudience);
  const requiredPreviewTier = tiers.find((tier) => tier.id === form.requiredTierId);
  const simulatedAudience = previewTier
    ? { level: previewTier.level }
    : previewAudience === "public"
      ? "guest"
      : "reader";
  const previewAllowed =
    previewAudience === "owner" ||
    canReadPostAudience(form.visibility, simulatedAudience, requiredPreviewTier?.level);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [categoryIds, setCategoryIds] = useState(selectedCategoryIds);
  const [tagIds, setTagIds] = useState(selectedTagIds);
  const [savedFormSnapshot, setSavedFormSnapshot] = useState(() => formSnapshot(form));
  const [savedTaxonomySnapshot, setSavedTaxonomySnapshot] = useState(() =>
    taxonomySnapshot(selectedCategoryIds, selectedTagIds),
  );
  const [translationDirty, setTranslationDirty] = useState(false);
  const currentFormSnapshot = useMemo(() => formSnapshot(form), [form]);
  const currentTaxonomySnapshot = useMemo(
    () => taxonomySnapshot(categoryIds, tagIds),
    [categoryIds, tagIds],
  );
  const hasUnsavedFormChanges = currentFormSnapshot !== savedFormSnapshot;
  const hasUnsavedTaxonomyChanges = currentTaxonomySnapshot !== savedTaxonomySnapshot;
  const hasUnsavedChanges = hasUnsavedFormChanges || hasUnsavedTaxonomyChanges;
  const hasAnyUnsavedChanges = hasUnsavedChanges || translationDirty;
  const hasUnsavedChangesRef = useRef(hasAnyUnsavedChanges);
  const unsavedChangesConfirmMessageRef = useRef(t("admin.posts.unsavedChangesConfirm"));
  const allowNextPopStateRef = useRef(false);
  const suppressBeforeUnloadRef = useRef(false);
  const collapseDirtyGuardRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const createdPostIdRef = useRef<string | null>(post?.id ?? null);
  const saveInFlightRef = useRef(false);
  hasUnsavedChangesRef.current = hasAnyUnsavedChanges;
  unsavedChangesConfirmMessageRef.current = t("admin.posts.unsavedChangesConfirm");

  useEffect(() => {
    if (!hasAnyUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (suppressBeforeUnloadRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasAnyUnsavedChanges]);

  useEffect(() => {
    if (!hasAnyUnsavedChanges) return;

    allowNextPopStateRef.current = false;

    const confirmNavigation = () => window.confirm(unsavedChangesConfirmMessageRef.current);
    // Used only by popstate (not anchor clicks) to ignore spurious iOS Safari
    // edge-swipe pops triggered while dragging text selection handles.
    const hasActiveTextSelection = () => {
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed && selection.toString().length > 0) return true;
      // The document Selection/Range API does not report selections made
      // inside a focused <textarea>/<input> (e.g. the markdown body editor);
      // those expose selection only via selectionStart/selectionEnd.
      const active = document.activeElement;
      if (
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement && active.type === "text")
      ) {
        return (active.selectionStart ?? 0) !== (active.selectionEnd ?? 0);
      }
      return false;
    };
    const shouldGuardUrl = (url?: string | URL | null) => {
      if (url === undefined || url === null) return false;
      try {
        const nextUrl = new URL(url, window.location.href);
        if (nextUrl.origin !== window.location.origin) return false;
        return (
          nextUrl.pathname !== window.location.pathname || nextUrl.search !== window.location.search
        );
      } catch {
        return false;
      }
    };
    const isDirtyGuardHistoryEntry = () => {
      const currentState = window.history.state;
      return (
        currentState &&
        typeof currentState === "object" &&
        currentState.__adminPostEditorDirtyGuard === true
      );
    };
    // Pass only the guard marker instead of spreading window.history.state;
    // Next.js's patched pushState attaches its own router fields, and duplicating
    // prior state triggered white screens on iOS Safari tab resume.
    const pushDirtyGuardHistoryEntry = () => {
      window.history.pushState({ __adminPostEditorDirtyGuard: true }, "", window.location.href);
    };
    const collapseDirtyGuardHistoryEntry = () => {
      if (!isDirtyGuardHistoryEntry()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pendingCollapseResolve = resolve;
        allowNextPopStateRef.current = true;
        window.history.back();
      });
    };
    collapseDirtyGuardRef.current = collapseDirtyGuardHistoryEntry;
    let logoutCollapsePromise: Promise<void> | null = null;
    let pendingCollapseResolve: (() => void) | null = null;

    pushDirtyGuardHistoryEntry();

    const handleDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      if (!shouldGuardUrl(anchor.href)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!confirmNavigation()) return;
      void collapseDirtyGuardHistoryEntry().then(() => {
        suppressBeforeUnloadRef.current = true;
        const nextUrl = new URL(anchor.href);
        router.push(`${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
      });
    };

    const handleBeforeLogout = (event: Event) => {
      if (!confirmNavigation()) {
        event.preventDefault();
        return;
      }
      logoutCollapsePromise = collapseDirtyGuardHistoryEntry().then(() => {
        suppressBeforeUnloadRef.current = true;
      });
      const waitUntil = (event as CustomEvent<{ waitUntil?: (promise: Promise<void>) => void }>)
        .detail?.waitUntil;
      if (waitUntil) waitUntil(logoutCollapsePromise);
      else suppressBeforeUnloadRef.current = true;
    };

    const handleLogoutAborted = () => {
      suppressBeforeUnloadRef.current = false;
      const collapsed = logoutCollapsePromise ?? Promise.resolve();
      logoutCollapsePromise = null;
      void collapsed.then(() => {
        allowNextPopStateRef.current = false;
        if (hasUnsavedChangesRef.current && !isDirtyGuardHistoryEntry()) {
          pushDirtyGuardHistoryEntry();
        }
      });
    };

    const handlePopState = (event: PopStateEvent) => {
      if (allowNextPopStateRef.current) {
        allowNextPopStateRef.current = false;
        const resolveCollapse = pendingCollapseResolve;
        if (resolveCollapse) {
          // A guard-entry collapse pops the same URL; keep it invisible to the
          // Next.js router, whose own popstate handling would asynchronously
          // replaceState and wipe a freshly re-pushed guard entry.
          event.stopImmediatePropagation();
          pendingCollapseResolve = null;
          resolveCollapse();
        }
        return;
      }
      event.stopImmediatePropagation();
      if (hasActiveTextSelection()) {
        // Ignore spurious selection/edge-swipe pops without blocking native copy;
        // re-push only if history actually moved off the guard entry.
        if (!isDirtyGuardHistoryEntry()) window.setTimeout(pushDirtyGuardHistoryEntry, 0);
        return;
      }
      if (confirmNavigation()) {
        allowNextPopStateRef.current = true;
        window.setTimeout(() => window.history.back(), 0);
        return;
      }
      window.setTimeout(pushDirtyGuardHistoryEntry, 0);
    };

    document.addEventListener("click", handleDocumentClick, true);
    window.addEventListener("admin:before-logout", handleBeforeLogout);
    window.addEventListener("admin:logout-aborted", handleLogoutAborted);
    window.addEventListener("popstate", handlePopState, true);
    return () => {
      collapseDirtyGuardRef.current = () => Promise.resolve();
      document.removeEventListener("click", handleDocumentClick, true);
      window.removeEventListener("admin:before-logout", handleBeforeLogout);
      window.removeEventListener("admin:logout-aborted", handleLogoutAborted);
      window.removeEventListener("popstate", handlePopState, true);
      if (!hasUnsavedChangesRef.current) void collapseDirtyGuardHistoryEntry();
    };
  }, [hasAnyUnsavedChanges, router]);

  async function run(fn: () => Promise<void>) {
    setLoading(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  function markCurrentStateSaved() {
    hasUnsavedChangesRef.current = false;
    setSavedFormSnapshot(formSnapshot(form));
    setSavedTaxonomySnapshot(taxonomySnapshot(categoryIds, tagIds));
  }

  function payload() {
    return {
      title: form.title,
      slug: form.slug,
      summary: form.summary || null,
      body: form.body || null,
      coverFileId: form.coverFileId,
      visibility: form.visibility,
      requiredTierId: form.visibility === "member" ? form.requiredTierId || null : null,
      categoryIds,
      tagIds,
    };
  }

  async function save() {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      await run(async () => {
        if (isNew) {
          const existingCreatedId = createdPostIdRef.current;
          const created = existingCreatedId
            ? await api<{ id: string }>(`/api/admin/posts/${existingCreatedId}`, {
                method: "PUT",
                body: payload(),
              })
            : await api<{ id: string }>("/api/admin/posts", {
                method: "POST",
                body: payload(),
              });
          createdPostIdRef.current = created.id;
          await collapseDirtyGuardRef.current();
          markCurrentStateSaved();
          suppressBeforeUnloadRef.current = true;
          router.replace(`/admin/posts/${created.id}`);
        } else {
          if (isPublished) {
            await api(`/api/admin/posts/${post.id}/content`, {
              method: "PUT",
              body: { body: form.body || null },
            });
          } else {
            await api(`/api/admin/posts/${post.id}`, { method: "PUT", body: payload() });
          }
          if (isPublished) {
            setSavedFormSnapshot(formSnapshot(form));
          } else {
            markCurrentStateSaved();
          }
          setMessage(t("admin.common.saved"));
          router.refresh();
        }
      });
    } finally {
      saveInFlightRef.current = false;
    }
  }

  async function saveTaxonomy() {
    if (!post) return;
    await run(async () => {
      await api(`/api/admin/posts/${post.id}/taxonomy`, {
        method: "PUT",
        body: { categoryIds, tagIds },
      });
      setSavedTaxonomySnapshot(taxonomySnapshot(categoryIds, tagIds));
      setMessage(t("admin.taxonomy.saved"));
      router.refresh();
    });
  }

  async function uploadInlineImage(file: File): Promise<string> {
    if (!post) throw new Error(t("admin.posts.createDraftFirst"));
    const record = await uploadFile<{ id: string }>("/api/admin/files/upload", file, {
      purpose: "content_image",
    });
    return `/api/files/${record.id}/download`;
  }

  async function uploadAndAttach(file: File, kind: "image" | "attachment") {
    if (!post || isPublished) return;
    await run(async () => {
      const record =
        kind === "image"
          ? await uploadFile<{ id: string }>("/api/admin/files/upload", file, {
              purpose: "content_image",
            })
          : await uploadStreamFile<{ id: string }>("/api/admin/files/upload/stream", file);
      await api(`/api/admin/posts/${post.id}/files`, {
        method: "POST",
        body: { fileId: record.id, kind },
      });
      setMessage(t("admin.posts.fileAdded"));
      router.refresh();
    });
  }

  return (
    <div className="min-w-0 max-w-2xl space-y-6" data-testid="post-editor">
      <div className="min-w-0 space-y-4">
        {hasAnyUnsavedChanges ? (
          <Notice variant="warning">{t("admin.posts.unsavedChanges")}</Notice>
        ) : isNew ? (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t("admin.posts.newDraftNotCreated", {
              action: t("admin.posts.createDraft"),
            })}
          </p>
        ) : (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t("admin.posts.allChangesSaved")}
          </p>
        )}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2" data-testid="post-editor-title-row">
          <FormField id="post-title" label={t("admin.posts.titleColumn")}>
            <Input
              value={form.title}
              disabled={loading || isPublished}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </FormField>
          <FormField id="post-slug" label={t("admin.posts.slug")}>
            <Input
              value={form.slug}
              disabled={loading || isPublished}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </FormField>
        </div>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">{t("admin.taxonomy.title")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <fieldset className="min-w-0 space-y-2">
              <legend className="text-sm font-medium">{t("admin.taxonomy.categories")}</legend>
              <div className="space-y-1">
                {categories.map((category) => (
                  <label key={category.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={categoryIds.includes(category.id)}
                      disabled={loading || isPublished}
                      onChange={(event) =>
                        setCategoryIds((current) =>
                          event.target.checked
                            ? [...current, category.id]
                            : current.filter((id) => id !== category.id),
                        )
                      }
                    />
                    {category.name}
                  </label>
                ))}
                {categories.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t("admin.taxonomy.none")}</p>
                )}
              </div>
            </fieldset>
            <fieldset className="min-w-0 space-y-2">
              <legend className="text-sm font-medium">{t("admin.taxonomy.tags")}</legend>
              <div className="space-y-1">
                {tags.map((tag) => (
                  <label key={tag.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={tagIds.includes(tag.id)}
                      disabled={loading || isPublished}
                      onChange={(event) =>
                        setTagIds((current) =>
                          event.target.checked
                            ? [...current, tag.id]
                            : current.filter((id) => id !== tag.id),
                        )
                      }
                    />
                    {tag.name}
                  </label>
                ))}
                {tags.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t("admin.taxonomy.none")}</p>
                )}
              </div>
            </fieldset>
          </CardContent>
        </Card>
        <FormField id="post-summary" label={t("admin.posts.summary")}>
          <Input
            value={form.summary}
            disabled={loading || isPublished}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
          />
        </FormField>
        <FormField
          id="post-body"
          label={t("admin.posts.body")}
          description={!post ? t("admin.posts.createDraftFirst") : undefined}
        >
          <MarkdownEditor
            id="post-body"
            value={form.body}
            onChange={(body) => setForm((current) => ({ ...current, body }))}
            onUploadImage={post ? uploadInlineImage : undefined}
            disabled={loading}
            ariaLabel={t("admin.posts.body")}
            previewRestricted={Boolean(blogCopy && !previewAllowed)}
            audiencePreview={
              blogCopy && (
                <div className="mb-4 space-y-3 border-b pb-3">
                  <label className="flex flex-wrap items-center gap-2 text-sm">
                    {blogCopy.previewAudience}
                    <select
                      value={previewAudience}
                      onChange={(event) => setPreviewAudience(event.target.value)}
                      className="rounded-md border bg-background px-2 py-1"
                    >
                      <option value="owner">{t("admin.title")}</option>
                      <option value="public">{blogCopy.publicAudience}</option>
                      <option value="login">{blogCopy.inviteAudience}</option>
                      {tiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!previewAllowed && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {blogCopy.previewRestricted}
                    </p>
                  )}
                  {previewAllowed && form.coverFileId && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/files/${form.coverFileId}/download`}
                      alt=""
                      className="max-h-48 max-w-full rounded-md border object-contain"
                    />
                  )}
                  {previewAllowed &&
                    attachedFiles
                      .filter((file) => file.kind === "image")
                      .map((file) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={file.fileId}
                          src={`/api/files/${file.fileId}/download`}
                          alt={file.originalName}
                          className="max-h-48 max-w-full rounded-md border object-contain"
                        />
                      ))}
                  {previewAllowed &&
                    attachedFiles
                      .filter((file) => file.kind === "attachment")
                      .map((file) => (
                        <p key={file.fileId} className="break-all text-sm">
                          {file.originalName}
                        </p>
                      ))}
                </div>
              )
            }
          />
        </FormField>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2" data-testid="post-editor-access-row">
          <FormField id="post-visibility" className="min-w-0" label={t("admin.posts.visibility")}>
            <select
              className="h-9 min-w-0 max-w-full w-full rounded-md border bg-transparent px-2 text-sm"
              value={form.visibility}
              disabled={loading || isPublished}
              onChange={(e) =>
                setForm({ ...form, visibility: e.target.value as typeof form.visibility })
              }
            >
              <option value="public">{blogCopy?.publicAudience ?? t("admin.posts.public")}</option>
              <option value="login">{blogCopy?.inviteAudience ?? t("admin.posts.login")}</option>
              <option value="member">{blogCopy?.memberAudience ?? t("admin.posts.member")}</option>
            </select>
          </FormField>
          {form.visibility === "member" && (
            <FormField
              id="post-required-tier"
              className="min-w-0"
              label={t("admin.posts.requiredTier")}
            >
              <select
                className="h-9 min-w-0 max-w-full w-full rounded-md border bg-transparent px-2 text-sm"
                value={form.requiredTierId}
                disabled={loading || isPublished}
                onChange={(e) => setForm({ ...form, requiredTierId: e.target.value })}
              >
                <option value="">{t("admin.posts.choose")}</option>
                {tiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {t("admin.posts.tierLevel", { name: tier.name, level: tier.level })}
                  </option>
                ))}
              </select>
            </FormField>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="post-cover">{t("admin.posts.cover")}</Label>
          {form.coverFileId && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/files/${form.coverFileId}/download`}
              alt={t("admin.posts.coverAlt")}
              className="h-auto max-w-full rounded-md border sm:w-48"
            />
          )}
          <Input
            id="post-cover"
            type="file"
            className={FILE_INPUT_CLASS}
            accept=".jpg,.jpeg,.png,.webp"
            disabled={loading || isPublished}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              run(async () => {
                const record = await uploadFile<{ id: string }>("/api/admin/files/upload", file, {
                  purpose: "cover",
                });
                setForm((f) => ({ ...f, coverFileId: record.id }));
                setMessage(t("admin.posts.coverUploaded"));
              });
            }}
          />
        </div>
        {message && <Notice className="break-words [overflow-wrap:anywhere]">{message}</Notice>}
        <div
          className="flex flex-col gap-2 sm:flex-row sm:flex-wrap"
          data-testid="post-editor-actions"
        >
          <Button
            className={MOBILE_ACTION_CLASS}
            disabled={loading || !form.title || !form.slug || (!isNew && !hasUnsavedChanges)}
            onClick={save}
          >
            {loading
              ? t("admin.common.saving")
              : isNew
                ? t("admin.posts.createDraft")
                : t("admin.common.save")}
          </Button>
          {!isNew && post.status !== "published" && (
            <Button
              className={MOBILE_ACTION_CLASS}
              variant="outline"
              disabled={loading}
              onClick={() =>
                run(async () => {
                  if (hasAnyUnsavedChanges) {
                    setMessage(t("admin.posts.saveBeforePublish"));
                    return;
                  }
                  if (!window.confirm(t("admin.posts.confirmPublish"))) return;
                  await api(`/api/admin/posts/${post.id}/publish`, { method: "POST" });
                  setMessage(t("admin.posts.published"));
                  router.refresh();
                })
              }
            >
              {t("admin.posts.publish")}
            </Button>
          )}
          {!isNew && post.status === "published" && (
            <Button
              className={MOBILE_ACTION_CLASS}
              variant="outline"
              disabled={loading}
              onClick={() =>
                run(async () => {
                  if (hasAnyUnsavedChanges) {
                    setMessage(t("admin.posts.saveBeforeArchive"));
                    return;
                  }
                  if (!window.confirm(t("admin.posts.confirmArchive"))) return;
                  await api(`/api/admin/posts/${post.id}/archive`, { method: "POST" });
                  setMessage(t("admin.posts.archived"));
                  router.refresh();
                })
              }
            >
              {t("admin.posts.archive")}
            </Button>
          )}
          {!isNew && (
            <Button
              className={MOBILE_ACTION_CLASS}
              variant="outline"
              disabled={loading || isPublished || !hasUnsavedTaxonomyChanges}
              onClick={saveTaxonomy}
            >
              {t("admin.taxonomy.saveAssociations")}
            </Button>
          )}
          {!isNew && (
            <Button
              className={MOBILE_ACTION_CLASS}
              variant="destructive"
              disabled={loading}
              onClick={() =>
                run(async () => {
                  if (!confirm(t("admin.posts.confirmDelete"))) return;
                  await api(`/api/admin/posts/${post.id}`, { method: "DELETE" });
                  router.push("/admin/posts");
                  router.refresh();
                })
              }
            >
              {t("admin.common.delete")}
            </Button>
          )}
        </div>
      </div>

      {!isNew && (
        <PostTranslationEditor
          postId={post.id}
          originalLocale={post.originalLocale}
          onDirtyChange={setTranslationDirty}
        />
      )}

      {!isNew && (
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">{t("admin.posts.gallery")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              {attachedFiles.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("admin.posts.noFiles")}</p>
              )}
              {attachedFiles.map((f) => (
                <div
                  key={f.fileId}
                  className="flex min-w-0 flex-col items-stretch gap-2 rounded-md border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                  data-testid="post-editor-attached-file"
                >
                  <span className="min-w-0 break-words [overflow-wrap:anywhere] sm:mr-2">
                    [{t(f.kind === "image" ? "admin.posts.image" : "admin.posts.attachment")}]{" "}
                    {f.originalName}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className={MOBILE_ACTION_CLASS}
                    disabled={loading || isPublished}
                    onClick={() =>
                      run(async () => {
                        await api(`/api/admin/posts/${post.id}/files`, {
                          method: "DELETE",
                          body: { fileId: f.fileId },
                        });
                        router.refresh();
                      })
                    }
                  >
                    {t("admin.common.remove")}
                  </Button>
                </div>
              ))}
            </div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="post-gallery-image">{t("admin.posts.uploadImage")}</Label>
                <Input
                  id="post-gallery-image"
                  type="file"
                  className={FILE_INPUT_CLASS}
                  accept=".jpg,.jpeg,.png,.webp,.gif"
                  disabled={loading || isPublished}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadAndAttach(file, "image");
                  }}
                />
              </div>
              <div className="min-w-0 space-y-1">
                <Label htmlFor="post-gallery-attachment">{t("admin.posts.uploadAttachment")}</Label>
                <Input
                  id="post-gallery-attachment"
                  type="file"
                  className={FILE_INPUT_CLASS}
                  accept=".jpg,.jpeg,.png,.webp,.gif,.zip,.psd,.clip,.brush,.abr,.procreate,.pdf,.txt,.mp4,.webm,.mov,.m4v"
                  disabled={loading || isPublished}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadAndAttach(file, "attachment");
                  }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
