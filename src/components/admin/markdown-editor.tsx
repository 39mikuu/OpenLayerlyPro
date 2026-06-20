"use client";

import { useEffect, useRef, useState } from "react";

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
  ariaLabel = "Markdown editor",
}: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
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
          if (active) setError(reason instanceof Error ? reason.message : "Preview failed");
        })
        .finally(() => {
          if (active) setPreviewLoading(false);
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [mode, value]);

  function replaceSelection(replacement: string, selectionOffset = replacement.length) {
    const textarea = textareaRef.current;
    if (!textarea) {
      onChange(`${value}${replacement}`);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    onChange(`${value.slice(0, start)}${replacement}${value.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + selectionOffset;
      textarea.setSelectionRange(cursor, cursor);
    });
  }

  function wrapSelection(prefix: string, suffix: string, placeholder: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || placeholder;
    const replacement = `${prefix}${selected}${suffix}`;
    onChange(`${value.slice(0, start)}${replacement}${value.slice(end)}`);
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    });
  }

  function prefixLines(prefix: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || "text";
    const replacement = selected
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
    onChange(`${value.slice(0, start)}${replacement}${value.slice(end)}`);
  }

  async function uploadImage(file: File) {
    if (!onUploadImage || disabled || uploading) return;
    if (!file.type.startsWith("image/")) {
      setError("Only image files can be inserted.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const url = await onUploadImage(file);
      const alt = file.name.replace(/\.[^.]+$/, "") || "image";
      replaceSelection(`![${alt}](${url})`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Image upload failed");
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
          onClick={() => wrapSelection("**", "**", "bold")}
        >
          Bold
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() => wrapSelection("*", "*", "italic")}
        >
          Italic
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() => prefixLines("## ")}
        >
          Heading
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() => wrapSelection("[", "](https://)", "link text")}
        >
          Link
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() => prefixLines("- ")}
        >
          Bullets
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() => prefixLines("1. ")}
        >
          Numbered
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() => prefixLines("> ")}
        >
          Quote
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() => wrapSelection("`", "`", "code")}
        >
          Code
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() => wrapSelection("```\n", "\n```", "code block")}
        >
          Code block
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toolbarDisabled}
          onClick={() =>
            replaceSelection("| Column 1 | Column 2 |\n| --- | --- |\n| Value 1 | Value 2 |\n")
          }
        >
          Table
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
          {uploading ? "Uploading…" : "Image"}
        </Button>
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "edit" ? "secondary" : "ghost"}
            onClick={() => setMode("edit")}
          >
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "preview" ? "secondary" : "ghost"}
            onClick={() => setMode("preview")}
          >
            Preview
          </Button>
        </div>
      </div>

      {mode === "edit" ? (
        <Textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          className="min-h-64 resize-y rounded-none border-0 font-mono focus-visible:ring-0"
          rows={rows}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
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
            <p className="text-sm text-muted-foreground">Rendering preview…</p>
          ) : previewHtml ? (
            <div className="prose-content" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing to preview.</p>
          )}
        </div>
      )}
      {error && <p className="border-t px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
