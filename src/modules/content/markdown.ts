import MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import sanitizeHtml from "sanitize-html";

import {
  EMBED_HOSTS,
  type EmbedProviderId,
  getAllowedEmbedProvider,
  getSafeVideoIframeAttributes,
  type ResolvedVideoEmbed,
  resolveVideoEmbed,
  VIDEO_EMBED_IFRAME_ALLOW,
  VIDEO_EMBED_REFERRER_POLICY,
} from "./video-embed";

export type MarkdownEmbedMode = "public" | "preview";

export type RenderMarkdownOptions = {
  embedMode?: MarkdownEmbedMode;
};

export const MAX_POST_BODY_LENGTH = 100_000;

const INTERNAL_IMAGE_PATH =
  /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/download$/i;
const VIDEO_DIRECTIVE = /^@video:\s+(\S+)\s*$/;

const PROVIDER_LABELS: Record<EmbedProviderId, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  bilibili: "Bilibili",
};

type SanitizedTag = {
  tagName: string;
  attribs: Record<string, string>;
};

function videoEmbedBlockRule(
  state: StateBlock,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  if (state.parentType !== "root" || state.sCount[startLine] !== 0) return false;

  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  const lineEnd = state.eMarks[startLine];
  const match = VIDEO_DIRECTIVE.exec(state.src.slice(lineStart, lineEnd));
  const resolved = match ? resolveVideoEmbed(match[1]) : null;
  if (!resolved) return false;
  if (silent) return true;

  const token = state.push("video_embed", "", 0);
  token.block = true;
  token.map = [startLine, startLine + 1];
  token.meta = resolved;
  state.line = startLine + 1;
  return true;
}

function renderVideoEmbed(resolved: ResolvedVideoEmbed, mode: MarkdownEmbedMode): string {
  const src = MarkdownIt().utils.escapeHtml(resolved.embedSrc);
  const title = MarkdownIt().utils.escapeHtml(resolved.title);
  if (mode === "preview") {
    const provider = MarkdownIt().utils.escapeHtml(resolved.provider);
    const providerLabel = MarkdownIt().utils.escapeHtml(PROVIDER_LABELS[resolved.provider]);
    return `<div class="video-embed-placeholder" data-provider="${provider}" data-embed-src="${src}"><button type="button" data-video-embed-load>${providerLabel}</button></div>\n`;
  }

  return `<div class="video-embed"><iframe src="${src}" title="${title}" loading="lazy" referrerpolicy="${VIDEO_EMBED_REFERRER_POLICY}" allow="${VIDEO_EMBED_IFRAME_ALLOW}" allowfullscreen></iframe></div>\n`;
}

function createMarkdown(embedMode: MarkdownEmbedMode): MarkdownIt {
  const instance = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
  });

  // Parse every Markdown destination and let the sanitizer be the single URL
  // authority. Otherwise markdown-it leaves rejected javascript:/data: syntax as
  // visible literal text, bypassing the sanitizer's URL policy entirely.
  instance.validateLink = () => true;
  instance.block.ruler.before("paragraph", "video_embed", videoEmbedBlockRule, {
    alt: ["paragraph", "reference", "blockquote"],
  });
  instance.renderer.rules.video_embed = (tokens, index) => {
    const resolved = tokens[index].meta as ResolvedVideoEmbed;
    return renderVideoEmbed(resolved, embedMode);
  };
  return instance;
}

function isSafeLink(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("?")) return true;
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function fixedIframeAttributes(src: string): Record<string, string> | null {
  const safe = getSafeVideoIframeAttributes(src);
  if (!safe) return null;
  return {
    src: safe.src,
    title: safe.title,
    loading: safe.loading,
    referrerpolicy: safe.referrerPolicy,
    allow: safe.allow,
    allowfullscreen: "",
  };
}

export function sanitizeMarkdownHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "hr",
      "strong",
      "em",
      "s",
      "blockquote",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "code",
      "pre",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "div",
      "iframe",
      "button",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title"],
      th: ["align"],
      td: ["align"],
      div: ["class", "data-provider", "data-embed-src"],
      iframe: ["src", "title", "loading", "referrerpolicy", "allow", "allowfullscreen"],
      button: ["type", "data-video-embed-load"],
    },
    allowedClasses: {
      div: ["video-embed", "video-embed-placeholder"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { iframe: ["https"] },
    allowProtocolRelative: false,
    allowedIframeHostnames: [...EMBED_HOSTS],
    transformTags: {
      a: (_tagName, attribs) => {
        if (!attribs.href || !isSafeLink(attribs.href)) {
          const rest = { ...attribs };
          delete rest.href;
          delete rest.target;
          delete rest.rel;
          return { tagName: "span", attribs: rest };
        }
        const next = { ...attribs };
        if (next.target === "_blank") next.rel = "noopener nofollow ugc";
        return { tagName: "a", attribs: next };
      },
      img: (_tagName, attribs) => {
        if (!attribs.src || !INTERNAL_IMAGE_PATH.test(attribs.src)) {
          return { tagName: "span", attribs: {} };
        }
        return {
          tagName: "img",
          attribs: {
            src: attribs.src,
            ...(attribs.alt ? { alt: attribs.alt } : {}),
            ...(attribs.title ? { title: attribs.title } : {}),
          },
        };
      },
      iframe: (_tagName, attribs) => {
        const safe = attribs.src ? fixedIframeAttributes(attribs.src) : null;
        return safe ? { tagName: "iframe", attribs: safe } : { tagName: "span", attribs: {} };
      },
      div: (_tagName, attribs): SanitizedTag => {
        if (attribs.class === "video-embed") {
          return { tagName: "div", attribs: { class: "video-embed" } };
        }
        if (attribs.class === "video-embed-placeholder" && attribs["data-embed-src"]) {
          const provider = getAllowedEmbedProvider(attribs["data-embed-src"]);
          if (provider && attribs["data-provider"] === provider) {
            return {
              tagName: "div",
              attribs: {
                class: "video-embed-placeholder",
                "data-provider": provider,
                "data-embed-src": attribs["data-embed-src"],
              },
            };
          }
        }
        return { tagName: "span", attribs: {} };
      },
      button: (_tagName, attribs): SanitizedTag => {
        if (attribs.type === "button" && "data-video-embed-load" in attribs) {
          return {
            tagName: "button",
            attribs: { type: "button", "data-video-embed-load": "" },
          };
        }
        return { tagName: "span", attribs: {} };
      },
    },
  });
}

export function renderMarkdown(
  source: string | null | undefined,
  options: RenderMarkdownOptions = {},
): string {
  if (!source) return "";
  const embedMode = options.embedMode ?? "public";
  return sanitizeMarkdownHtml(createMarkdown(embedMode).render(source));
}

export function extractInternalImageFileIds(source: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!source) return ids;

  const visit = (tokens: ReturnType<MarkdownIt["parse"]>) => {
    for (const token of tokens) {
      if (token.type === "image") {
        const src = token.attrGet("src");
        const match = src ? INTERNAL_IMAGE_PATH.exec(src) : null;
        if (match) ids.add(match[1].toLowerCase());
      }
      if (token.children) visit(token.children);
    }
  };

  visit(createMarkdown("public").parse(source, {}));
  return ids;
}

export function isInternalImageDownloadPath(value: string): boolean {
  return INTERNAL_IMAGE_PATH.test(value);
}
