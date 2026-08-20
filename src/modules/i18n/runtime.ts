import type { Messages } from "./messages/zh";

export type Translate = (key: string, params?: Record<string, string | number>) => string;

function getPath(obj: unknown, key: string): string | undefined {
  let current: unknown = obj;
  for (const part of key.split(".")) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  );
}

/** Translate against supplied catalogs without importing any locale bundle. */
export function translateMessages(
  messages: Messages,
  key: string,
  params?: Record<string, string | number>,
  fallback?: Messages,
): string {
  const raw = getPath(messages, key) ?? getPath(fallback, key) ?? key;
  return interpolate(raw, params);
}

function mergeCatalogValue(fallback: unknown, primary: unknown): unknown {
  if (typeof primary === "string") return primary;
  if (!primary || typeof primary !== "object") return fallback;
  if (!fallback || typeof fallback !== "object") return primary;

  const fallbackRecord = fallback as Record<string, unknown>;
  const primaryRecord = primary as Record<string, unknown>;
  const keys = new Set([...Object.keys(fallbackRecord), ...Object.keys(primaryRecord)]);
  return Object.fromEntries(
    Array.from(keys, (key) => [key, mergeCatalogValue(fallbackRecord[key], primaryRecord[key])]),
  );
}

/** Build one active-locale catalog with default-locale gaps filled server-side. */
export function mergeMessages(fallback: Messages, primary: Messages): Messages {
  return mergeCatalogValue(fallback, primary) as Messages;
}
