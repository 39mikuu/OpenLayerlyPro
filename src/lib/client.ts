"use client";

import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, translate } from "@/modules/i18n";

type ApiResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code?: string;
      params?: Record<string, string | number>;
      error: string;
    };

function currentLocale() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  const locale = match ? decodeURIComponent(match[1]) : null;
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

function errorMessage(response: Extract<ApiResponse<unknown>, { ok: false }>): string {
  if (!response.code) return response.error;
  const key = `errors.${response.code}`;
  const localized = translate(currentLocale(), key, response.params);
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
    throw new Error(translate(currentLocale(), "common.requestFailed", { status: res.status }));
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
    throw new Error(translate(currentLocale(), "common.uploadFailed", { status: res.status }));
  }
  if (!json.ok) throw new Error(errorMessage(json) || `Upload failed (${res.status})`);
  return json.data;
}
