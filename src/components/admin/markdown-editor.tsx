"use client";

import { useEffect, useRef, useState } from "react";

import { insertMarkdownAtSelection } from "@/components/admin/markdown-editor-model";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
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
  const valueRef = useRef(value);
  valueRef.current = value;
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "preview") return;
    let active = true;
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

  const toolbarDisabled = disabled || mode === "preview";

  return (
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
          onClick={() => wrapSelection("```\n", "\n```", t("admin.markdown.codeBlockPlaceholder"))}
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
            <p className="text-sm text-muted-foreground">{t("admin.markdown.renderingPreview")}</p>
          ) : previewHtml ? (
            <div className="prose-content" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("admin.markdown.nothingToPreview")}</p>
          )}
        </div>
      )}
      {error && <p className="border-t px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
