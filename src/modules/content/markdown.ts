import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

export type MarkdownEmbedMode = "public" | "preview";

export type RenderMarkdownOptions = {
  embedMode?: MarkdownEmbedMode;
};

export const MAX_POST_BODY_LENGTH = 100_000;

const INTERNAL_IMAGE_PATH =
  /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/download$/i;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

// Parse every Markdown destination and let the sanitizer be the single URL
// authority. Otherwise markdown-it leaves rejected javascript:/data: syntax as
// visible literal text, bypassing the sanitizer's URL policy entirely.
markdown.validateLink = () => true;

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

function sanitizeRenderedHtml(html: string): string {
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
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title"],
      th: ["align"],
      td: ["align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
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
        if (next.target === "_blank") {
          next.rel = "noopener nofollow ugc";
        }
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
    },
  });
}

export function renderMarkdown(
  source: string | null | undefined,
  options: RenderMarkdownOptions = { embedMode: "public" },
): string {
  void options.embedMode;
  if (!source) return "";
  return sanitizeRenderedHtml(markdown.render(source));
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

  visit(markdown.parse(source, {}));
  return ids;
}

export function isInternalImageDownloadPath(value: string): boolean {
  return INTERNAL_IMAGE_PATH.test(value);
}
