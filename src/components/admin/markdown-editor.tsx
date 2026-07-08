"use client";

import { useEffect, useRef, useState } from "react";

import {
  getPreviewVideoIframeAttributes,
  insertMarkdownAtSelection,
  insertVideoDirectiveAtSelection,
  type TextSelection,
} from "@/components/admin/markdown-editor-model";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";

type PreviewResponse = { html: string };

type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onUploadImage?: (file: File) => Promise<string>;
  disabled?: boolean;
  rows?: number;
  ariaLabel?: string;
};

export function MarkdownEditor({
  value,
  onChange,
  onUploadImage,
  disabled = false,
  rows = 12,
  ariaLabel,
}: MarkdownEditorProps) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const videoSelectionRef = useRef<TextSelection>({ start: value.length, end: value.length });
  const valueRef = useRef(value);
  valueRef.current = value;
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoError, setVideoError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "preview") return;
    let active = true;
    setPreviewHtml("");
    const timer = window.setTimeout(() => {
      setPreviewLoading(true);
      setError(null);
      api<PreviewResponse>("/api/admin/posts/preview", {
        method: "POST",
        body: { markdown: value, embedMode: "preview" },
      })
        .then((response) => {
          if (active) setPreviewHtml(response.html);
        })
        .catch((reason) => {
          if (active)
            setError(reason instanceof Error ? reason.message : t("admin.markdown.previewFailed"));
        })
        .finally(() => {
          if (active) setPreviewLoading(false);
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [mode, t, value]);

  useEffect(() => {
    if (mode !== "preview" || !previewHtml) return;
    const container = previewRef.current;
    if (!container) return;

    for (const button of container.querySelectorAll<HTMLButtonElement>("[data-video-embed-load]")) {
      const placeholder = button.closest<HTMLElement>(".video-embed-placeholder");
      const provider = button.textContent?.trim() || placeholder?.dataset.provider || "";
      button.textContent = provider
        ? `${t("admin.markdown.loadVideo")} · ${provider}`
        : t("admin.markdown.loadVideo");
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("[data-video-embed-load]");
      if (!button || !container.contains(button)) return;
      const placeholder = button.closest<HTMLElement>(".video-embed-placeholder");
      const attributes = getPreviewVideoIframeAttributes(placeholder?.dataset.embedSrc ?? "");
      if (!placeholder || !attributes) {
        setError(t("admin.markdown.videoLoadFailed"));
        return;
      }

      const wrapper = document.createElement("div");
      wrapper.className = "video-embed";
      const iframe = document.createElement("iframe");
      iframe.src = attributes.src;
      iframe.title = attributes.title;
      iframe.loading = attributes.loading;
      iframe.referrerPolicy = attributes.referrerPolicy;
      iframe.allow = attributes.allow;
      iframe.allowFullscreen = attributes.allowFullscreen;
      wrapper.append(iframe);
      placeholder.replaceWith(wrapper);
      setError(null);
    };

    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, [mode, previewHtml, t]);

  function commitValue(nextValue: string) {
    valueRef.current = nextValue;
    onChange(nextValue);
  }

  function replaceSelection(replacement: string, selectionOffset = replacement.length) {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    const result = insertMarkdownAtSelection(
      currentValue,
      {
        start: textarea?.selectionStart ?? currentValue.length,
        end: textarea?.selectionEnd ?? currentValue.length,
      },
      replacement,
      selectionOffset,
    );
    commitValue(result.value);
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(result.cursor, result.cursor);
    });
  }

  function wrapSelection(prefix: string, suffix: string, placeholder: string) {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    const start = textarea?.selectionStart ?? currentValue.length;
    const end = textarea?.selectionEnd ?? currentValue.length;
    const selected = currentValue.slice(start, end) || placeholder;
    const replacement = `${prefix}${selected}${suffix}`;
    const result = insertMarkdownAtSelection(currentValue, { start, end }, replacement);
    commitValue(result.value);
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    });
  }

  function prefixLines(prefix: string) {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    const start = textarea?.selectionStart ?? currentValue.length;
    const end = textarea?.selectionEnd ?? currentValue.length;
    const selected = currentValue.slice(start, end) || t("admin.markdown.textPlaceholder");
    const replacement = selected
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
    commitValue(insertMarkdownAtSelection(currentValue, { start, end }, replacement).value);
  }

  async function uploadImage(file: File) {
    if (!onUploadImage || disabled || uploading) return;
    if (!file.type.startsWith("image/")) {
      setError(t("admin.markdown.imageOnly"));
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const url = await onUploadImage(file);
      const alt = file.name.replace(/\.[^.]+$/, "") || t("admin.markdown.imageAlt");
      replaceSelection(`![${alt}](${url})`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.markdown.uploadFailed"));
    } finally {
      setUploading(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  function openVideoDialog() {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    videoSelectionRef.current = {
      start: textarea?.selectionStart ?? currentValue.length,
      end: textarea?.selectionEnd ?? currentValue.length,
    };
    setVideoUrl("");
    setVideoError(null);
    setVideoDialogOpen(true);
  }

  function insertVideo() {
    const result = insertVideoDirectiveAtSelection(
      valueRef.current,
      videoSelectionRef.current,
      videoUrl,
    );
    if (!result) {
      setVideoError(t("admin.markdown.unsupportedVideoSource"));
      return;
    }
    commitValue(result.value);
    setVideoDialogOpen(false);
    setVideoError(null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(result.cursor, result.cursor);
    });
  }

  const toolbarDisabled = disabled || mode === "preview";

  return (
    <>
      <div className="overflow-hidden rounded-md border">
        <div className="flex flex-wrap items-center gap-1 border-b bg-muted/40 p-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => wrapSelection("**", "**", t("admin.markdown.boldPlaceholder"))}
          >
            {t("admin.markdown.bold")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => wrapSelection("*", "*", t("admin.markdown.italicPlaceholder"))}
          >
            {t("admin.markdown.italic")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => prefixLines("## ")}
          >
            {t("admin.markdown.heading")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => wrapSelection("[", "](https://)", t("admin.markdown.linkPlaceholder"))}
          >
            {t("admin.markdown.link")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => prefixLines("- ")}
          >
            {t("admin.markdown.bullets")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => prefixLines("1. ")}
          >
            {t("admin.markdown.numbered")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => prefixLines("> ")}
          >
            {t("admin.markdown.quote")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => wrapSelection("`", "`", t("admin.markdown.codePlaceholder"))}
          >
            {t("admin.markdown.code")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() =>
              wrapSelection("```\n", "\n```", t("admin.markdown.codeBlockPlaceholder"))
            }
          >
            {t("admin.markdown.codeBlock")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={() => replaceSelection(t("admin.markdown.tableTemplate"))}
          >
            {t("admin.markdown.table")}
          </Button>
          <input
            ref={imageInputRef}
            className="hidden"
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.gif"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadImage(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled || !onUploadImage || uploading}
            onClick={() => imageInputRef.current?.click()}
          >
            {uploading ? t("admin.markdown.uploading") : t("admin.markdown.image")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toolbarDisabled}
            onClick={openVideoDialog}
          >
            {t("admin.markdown.insertPublicVideo")}
          </Button>
          <div className="ml-auto flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={mode === "edit" ? "secondary" : "ghost"}
              onClick={() => setMode("edit")}
            >
              {t("admin.markdown.edit")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "preview" ? "secondary" : "ghost"}
              onClick={() => setMode("preview")}
            >
              {t("admin.markdown.preview")}
            </Button>
          </div>
        </div>

        {mode === "edit" ? (
          <Textarea
            ref={textareaRef}
            aria-label={ariaLabel ?? t("admin.markdown.ariaLabel")}
            className="min-h-64 resize-y rounded-none border-0 font-mono focus-visible:ring-0"
            rows={rows}
            value={value}
            disabled={disabled}
            onChange={(event) => commitValue(event.target.value)}
            onPaste={(event) => {
              const file = [...event.clipboardData.files].find((candidate) =>
                candidate.type.startsWith("image/"),
              );
              if (!file || !onUploadImage) return;
              event.preventDefault();
              void uploadImage(file);
            }}
            onDragOver={(event) => {
              if (onUploadImage) event.preventDefault();
            }}
            onDrop={(event) => {
              const file = [...event.dataTransfer.files].find((candidate) =>
                candidate.type.startsWith("image/"),
              );
              if (!file || !onUploadImage) return;
              event.preventDefault();
              void uploadImage(file);
            }}
          />
        ) : (
          <div className="min-h-64 p-4">
            {previewLoading ? (
              <p className="text-sm text-muted-foreground">
                {t("admin.markdown.renderingPreview")}
              </p>
            ) : previewHtml ? (
              <div
                ref={previewRef}
                className="prose-content"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("admin.markdown.nothingToPreview")}
              </p>
            )}
          </div>
        )}
        {error && <p className="border-t px-3 py-2 text-sm text-destructive">{error}</p>}
      </div>

      <Dialog
        open={videoDialogOpen}
        onOpenChange={(open) => {
          setVideoDialogOpen(open);
          if (!open) setVideoError(null);
        }}
      >
        <DialogContent closeLabel={t("admin.common.close")}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              insertVideo();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("admin.markdown.insertPublicVideo")}</DialogTitle>
              <DialogDescription>{t("admin.markdown.supportedVideoProviders")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="markdown-video-url">{t("admin.markdown.videoUrl")}</Label>
              <Input
                id="markdown-video-url"
                type="url"
                value={videoUrl}
                placeholder="https://www.youtube.com/watch?v=..."
                aria-describedby={videoError ? "markdown-video-url-error" : undefined}
                aria-invalid={Boolean(videoError)}
                autoFocus
                onChange={(event) => {
                  setVideoUrl(event.target.value);
                  setVideoError(null);
                }}
              />
              {videoError && (
                <p id="markdown-video-url-error" role="alert" className="text-sm text-destructive">
                  {videoError}
                </p>
              )}
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
              <p>{t("admin.markdown.thirdPartyNotMemberOnly")}</p>
              <p>{t("admin.markdown.memberVideoUploadHint")}</p>
            </div>
            <DialogFooter>
              <Button type="submit">{t("admin.markdown.insertPublicVideo")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
