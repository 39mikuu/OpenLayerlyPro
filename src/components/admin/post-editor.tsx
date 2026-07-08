"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { MarkdownEditor } from "@/components/admin/markdown-editor";
import { PostTranslationEditor } from "@/components/admin/post-translation-editor";
import { Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, uploadFile, uploadStreamFile } from "@/lib/client";

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
}: {
  post: PostData | null;
  tiers: TierOption[];
  attachedFiles: AttachedFile[];
  categories: TaxonomyOption[];
  tags: TaxonomyOption[];
  selectedCategoryIds: string[];
  selectedTagIds: string[];
}) {
  const router = useRouter();
  const t = useT();
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
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [categoryIds, setCategoryIds] = useState(selectedCategoryIds);
  const [tagIds, setTagIds] = useState(selectedTagIds);
  const [savedFormSnapshot, setSavedFormSnapshot] = useState(() => formSnapshot(form));
  const [savedTaxonomySnapshot, setSavedTaxonomySnapshot] = useState(() =>
    taxonomySnapshot(selectedCategoryIds, selectedTagIds),
  );
  const currentFormSnapshot = useMemo(() => formSnapshot(form), [form]);
  const currentTaxonomySnapshot = useMemo(
    () => taxonomySnapshot(categoryIds, tagIds),
    [categoryIds, tagIds],
  );
  const hasUnsavedFormChanges = currentFormSnapshot !== savedFormSnapshot;
  const hasUnsavedTaxonomyChanges = currentTaxonomySnapshot !== savedTaxonomySnapshot;
  const hasUnsavedChanges = hasUnsavedFormChanges || hasUnsavedTaxonomyChanges;

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
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
      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;
      if (
        nextUrl.pathname === window.location.pathname &&
        nextUrl.search === window.location.search
      )
        return;
      if (!window.confirm(t("admin.posts.unsavedChangesConfirm"))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", handleDocumentClick, true);
    return () => document.removeEventListener("click", handleDocumentClick, true);
  }, [hasUnsavedChanges, t]);

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
    await run(async () => {
      if (isNew) {
        const created = await api<{ id: string }>("/api/admin/posts", {
          method: "POST",
          body: payload(),
        });
        markCurrentStateSaved();
        router.push(`/admin/posts/${created.id}`);
        router.refresh();
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
    <div className="max-w-2xl space-y-6">
      <div className="space-y-4">
        {hasUnsavedChanges ? (
          <Notice variant="warning">{t("admin.posts.unsavedChanges")}</Notice>
        ) : (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t("admin.posts.allChangesSaved")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t("admin.posts.titleColumn")}</Label>
            <Input
              value={form.title}
              disabled={loading || isPublished}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("admin.posts.slug")}</Label>
            <Input
              value={form.slug}
              disabled={loading || isPublished}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("admin.taxonomy.title")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("admin.taxonomy.categories")}</Label>
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
            </div>
            <div className="space-y-2">
              <Label>{t("admin.taxonomy.tags")}</Label>
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
            </div>
          </CardContent>
        </Card>
        <div className="space-y-1">
          <Label>{t("admin.posts.summary")}</Label>
          <Input
            value={form.summary}
            disabled={loading || isPublished}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.posts.body")}</Label>
          <MarkdownEditor
            value={form.body}
            onChange={(body) => setForm((current) => ({ ...current, body }))}
            onUploadImage={post ? uploadInlineImage : undefined}
            disabled={loading}
            ariaLabel={t("admin.posts.body")}
          />
          {!post && (
            <p className="text-xs text-muted-foreground">{t("admin.posts.createDraftFirst")}</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t("admin.posts.visibility")}</Label>
            <select
              className="border rounded-md h-9 px-2 w-full bg-transparent text-sm"
              value={form.visibility}
              disabled={loading || isPublished}
              onChange={(e) =>
                setForm({ ...form, visibility: e.target.value as typeof form.visibility })
              }
            >
              <option value="public">{t("admin.posts.public")}</option>
              <option value="login">{t("admin.posts.login")}</option>
              <option value="member">{t("admin.posts.member")}</option>
            </select>
          </div>
          {form.visibility === "member" && (
            <div className="space-y-1">
              <Label>{t("admin.posts.requiredTier")}</Label>
              <select
                className="border rounded-md h-9 px-2 w-full bg-transparent text-sm"
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
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t("admin.posts.cover")}</Label>
          {form.coverFileId && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/files/${form.coverFileId}/download`}
              alt={t("admin.posts.coverAlt")}
              className="w-48 rounded-md border"
            />
          )}
          <Input
            type="file"
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
        {message && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
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
              variant="outline"
              disabled={loading}
              onClick={() =>
                run(async () => {
                  if (hasUnsavedChanges) {
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
              variant="outline"
              disabled={loading}
              onClick={() =>
                run(async () => {
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
              variant="outline"
              disabled={loading || isPublished || !hasUnsavedTaxonomyChanges}
              onClick={saveTaxonomy}
            >
              {t("admin.taxonomy.saveAssociations")}
            </Button>
          )}
          {!isNew && (
            <Button
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

      {!isNew && <PostTranslationEditor postId={post.id} originalLocale={post.originalLocale} />}

      {!isNew && (
        <Card>
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
                  className="flex items-center justify-between border rounded-md px-3 py-2 text-sm"
                >
                  <span className="truncate mr-2">
                    [{t(f.kind === "image" ? "admin.posts.image" : "admin.posts.attachment")}]{" "}
                    {f.originalName}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t("admin.posts.uploadImage")}</Label>
                <Input
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,.gif"
                  disabled={loading || isPublished}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadAndAttach(file, "image");
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("admin.posts.uploadAttachment")}</Label>
                <Input
                  type="file"
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
