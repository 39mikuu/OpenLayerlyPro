export type EmbedProviderId = "youtube" | "vimeo" | "bilibili";

export type ResolvedVideoEmbed = {
  provider: EmbedProviderId;
  originalUrl: string;
  embedSrc: string;
  title: string;
};

export const EMBED_HOSTS = [
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "player.bilibili.com",
] as const;

export const EMBED_FRAME_SOURCES: readonly string[] = EMBED_HOSTS.map(
  (hostname) => `https://${hostname}`,
);

export const VIDEO_EMBED_IFRAME_ALLOW =
  "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";
export const VIDEO_EMBED_REFERRER_POLICY = "strict-origin-when-cross-origin" as const;

export type SafeVideoIframeAttributes = {
  src: string;
  title: string;
  loading: "lazy";
  referrerPolicy: typeof VIDEO_EMBED_REFERRER_POLICY;
  allow: typeof VIDEO_EMBED_IFRAME_ALLOW;
  allowFullscreen: true;
};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,20}$/;
const BILIBILI_ID = /^BV[A-Za-z0-9]{10}$/;
const INVALID_RAW_URL = /[\s\u0000-\u001f\u007f]/u;

const PROVIDER_TITLES: Record<EmbedProviderId, string> = {
  youtube: "YouTube video",
  vimeo: "Vimeo video",
  bilibili: "Bilibili video",
};

function parseHttpsUrl(rawUrl: string): URL | null {
  if (!rawUrl || rawUrl.length > 2048 || INVALID_RAW_URL.test(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      rawUrl.startsWith("//")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function singlePathSegment(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 1 ? segments[0] : null;
}

function resolveYouTube(parsed: URL): string | null {
  let id: string | null = null;
  if (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") {
    if (parsed.pathname === "/watch" || parsed.pathname === "/watch/") {
      const ids = parsed.searchParams.getAll("v");
      id = ids.length === 1 ? ids[0] : null;
    } else {
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length === 2 && segments[0] === "shorts") id = segments[1];
    }
  } else if (parsed.hostname === "youtu.be") {
    id = singlePathSegment(parsed.pathname);
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

function resolveVimeo(parsed: URL): string | null {
  if (parsed.hostname !== "vimeo.com" && parsed.hostname !== "www.vimeo.com") return null;
  const id = singlePathSegment(parsed.pathname);
  return id && VIMEO_ID.test(id) ? id : null;
}

function resolveBilibili(parsed: URL): string | null {
  if (parsed.hostname !== "bilibili.com" && parsed.hostname !== "www.bilibili.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const id = segments.length === 2 && segments[0] === "video" ? segments[1] : null;
  return id && BILIBILI_ID.test(id) ? id : null;
}

export function resolveVideoEmbed(rawUrl: string): ResolvedVideoEmbed | null {
  const parsed = parseHttpsUrl(rawUrl);
  if (!parsed) return null;

  const youtubeId = resolveYouTube(parsed);
  if (youtubeId) {
    return {
      provider: "youtube",
      originalUrl: rawUrl,
      embedSrc: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
      title: PROVIDER_TITLES.youtube,
    };
  }

  const vimeoId = resolveVimeo(parsed);
  if (vimeoId) {
    return {
      provider: "vimeo",
      originalUrl: rawUrl,
      embedSrc: `https://player.vimeo.com/video/${vimeoId}`,
      title: PROVIDER_TITLES.vimeo,
    };
  }

  const bilibiliId = resolveBilibili(parsed);
  if (bilibiliId) {
    return {
      provider: "bilibili",
      originalUrl: rawUrl,
      embedSrc: `https://player.bilibili.com/player.html?bvid=${bilibiliId}`,
      title: PROVIDER_TITLES.bilibili,
    };
  }

  return null;
}

export function getAllowedEmbedProvider(rawUrl: string): EmbedProviderId | null {
  const parsed = parseHttpsUrl(rawUrl);
  if (!parsed || parsed.hash) return null;

  if (parsed.hostname === EMBED_HOSTS[0]) {
    if (parsed.search || !/^\/embed\/[A-Za-z0-9_-]{11}$/.test(parsed.pathname)) return null;
    return "youtube";
  }

  if (parsed.hostname === EMBED_HOSTS[1]) {
    if (parsed.search || !/^\/video\/\d{1,20}$/.test(parsed.pathname)) return null;
    return "vimeo";
  }

  if (parsed.hostname === EMBED_HOSTS[2]) {
    if (parsed.pathname !== "/player.html") return null;
    const entries = [...parsed.searchParams.entries()];
    if (entries.length !== 1 || entries[0][0] !== "bvid" || !BILIBILI_ID.test(entries[0][1])) {
      return null;
    }
    return "bilibili";
  }

  return null;
}

export function isAllowedEmbedSrc(rawUrl: string): boolean {
  return getAllowedEmbedProvider(rawUrl) !== null;
}

export function getSafeVideoIframeAttributes(rawUrl: string): SafeVideoIframeAttributes | null {
  const provider = getAllowedEmbedProvider(rawUrl);
  if (!provider) return null;
  return {
    src: rawUrl,
    title: PROVIDER_TITLES[provider],
    loading: "lazy",
    referrerPolicy: VIDEO_EMBED_REFERRER_POLICY,
    allow: VIDEO_EMBED_IFRAME_ALLOW,
    allowFullscreen: true,
  };
}
