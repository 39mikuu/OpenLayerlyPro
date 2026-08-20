"use client";

import { translateClient } from "@/modules/i18n/client";

type ApiResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code?: string;
      params?: Record<string, string | number>;
      error: string;
    };

function errorMessage(response: Extract<ApiResponse<unknown>, { ok: false }>): string {
  if (!response.code) return response.error;
  const key = `errors.${response.code}`;
  const localized = translateClient(key, response.params);
  return localized === key ? response.error : localized;
}

export async function api<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(path, {
    method: options?.method ?? "GET",
    headers: options?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json) {
    const key = "common.requestFailed";
    const localized = translateClient(key, { status: res.status });
    throw new Error(localized === key ? `Request failed (${res.status})` : localized);
  }
  if (!json.ok) throw new Error(errorMessage(json) || `Request failed (${res.status})`);
  return json.data;
}

export async function uploadFile<T = unknown>(
  path: string,
  file: File,
  extra?: Record<string, string>,
): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v);
  const res = await fetch(path, { method: "POST", body: form });
  const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json) {
    const key = "common.uploadFailed";
    const localized = translateClient(key, { status: res.status });
    throw new Error(localized === key ? `Upload failed (${res.status})` : localized);
  }
  if (!json.ok) throw new Error(errorMessage(json) || `Upload failed (${res.status})`);
  return json.data;
}

export async function uploadStreamFile<T = unknown>(path: string, file: File): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
      "x-file-purpose": "content_attachment",
    },
    body: file,
  });
  const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json) {
    const key = "common.uploadFailed";
    const localized = translateClient(key, { status: res.status });
    throw new Error(localized === key ? `Upload failed (${res.status})` : localized);
  }
  if (!json.ok) throw new Error(errorMessage(json) || `Upload failed (${res.status})`);
  return json.data;
}
