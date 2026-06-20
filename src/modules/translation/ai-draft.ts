import type { Post, PostTranslation } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getTranslationConfig } from "@/modules/config";
import { getPostById, publishTranslation, upsertDraftTranslation } from "@/modules/content";
import { isLocale, type Locale } from "@/modules/i18n";

import { getTranslationProvider } from "./index";
import { protectMarkdownForTranslation, restoreProtectedMarkdown } from "./markdown-protection";
import type { TranslationProvider, TranslationRequest, TranslationTargetLocale } from "./types";

export const MAX_TRANSLATION_CHUNK_CHARS = 6_000;

function requireSupportedLocale(locale: string): asserts locale is Locale {
  if (!isLocale(locale)) throw new ApiError(400, "unsupportedLocale", { locale });
}

function requireTargetLocale(locale: Locale): asserts locale is TranslationTargetLocale {
  if (locale !== "en" && locale !== "ja") {
    throw new ApiError(400, "unsupportedLocale", { locale });
  }
}

function requireSourceLocale(locale: string): Locale {
  if (!isLocale(locale)) throw new ApiError(400, "unsupportedLocale", { locale });
  return locale;
}

export function splitTranslationText(
  text: string,
  maxChars = MAX_TRANSLATION_CHUNK_CHARS,
): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive integer");
  }
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const maximumEnd = Math.min(start + maxChars, text.length);
    if (maximumEnd === text.length) {
      chunks.push(text.slice(start));
      break;
    }

    let end = text.lastIndexOf("\n\n", maximumEnd - 2);
    let separatorLength = 2;
    if (end < start || end + separatorLength > maximumEnd) {
      end = -1;
    }
    if (end < start) {
      end = text.lastIndexOf("\n", maximumEnd - 1);
      separatorLength = 1;
      if (end < start || end + separatorLength > maximumEnd) {
        end = -1;
      }
    }
    if (end < start) {
      end = maximumEnd;
      separatorLength = 0;
    }

    const nextStart = end + separatorLength;
    chunks.push(text.slice(start, nextStart));
    start = nextStart;
  }

  return chunks;
}

async function translateText(
  provider: TranslationProvider,
  text: string,
  sourceLocale: Locale,
  targetLocale: TranslationTargetLocale,
  maxChars?: number,
): Promise<string> {
  const chunks = splitTranslationText(text, maxChars);
  const translated: string[] = [];

  for (const chunk of chunks) {
    const request: TranslationRequest = {
      text: chunk,
      sourceLocale,
      targetLocale,
    };
    translated.push(await provider.translate(request));
  }

  return translated.join("");
}

async function translateOptionalText(
  provider: TranslationProvider,
  text: string | null,
  sourceLocale: Locale,
  targetLocale: TranslationTargetLocale,
  maxChars?: number,
): Promise<string | null> {
  if (text === null || text === "") return text;
  return translateText(provider, text, sourceLocale, targetLocale, maxChars);
}

async function translateMarkdownText(
  provider: TranslationProvider,
  text: string | null,
  sourceLocale: Locale,
  targetLocale: TranslationTargetLocale,
): Promise<string | null> {
  if (text === null || text === "") return text;
  const protection = protectMarkdownForTranslation(text);
  const translated = await translateText(provider, protection.markdown, sourceLocale, targetLocale);
  return restoreProtectedMarkdown(translated, protection);
}

export async function generateAiTranslationDraft(
  postId: string,
  locale: string,
): Promise<PostTranslation> {
  requireSupportedLocale(locale);
  const post: Post | null = await getPostById(postId);
  if (!post) throw new ApiError(404, "postNotFound");
  if (post.originalLocale === locale) {
    throw new ApiError(400, "translationOriginalLocale", { locale });
  }
  requireTargetLocale(locale);

  const sourceLocale = requireSourceLocale(post.originalLocale);
  const config = await getTranslationConfig();
  const provider = await getTranslationProvider();

  // Translate everything before writing so a provider failure cannot leave a partial draft.
  const title = await translateText(provider, post.title, sourceLocale, locale);
  const summary = await translateOptionalText(provider, post.summary, sourceLocale, locale);
  const body = await translateMarkdownText(provider, post.body, sourceLocale, locale);

  const draft = await upsertDraftTranslation(post.id, locale, {
    title,
    summary,
    body,
    source: "machine",
  });
  if (!config.directPublishEnabled) return draft;
  return publishTranslation(post.id, locale);
}
