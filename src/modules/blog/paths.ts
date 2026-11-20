const legacyReaderPaths = ["/me", "/tiers", "/checkout"];

export function readerPath(path: string, personalBlog: boolean): string {
  return personalBlog ? `/inside${path}` : path;
}

export function isLegacyReaderPath(path: string): boolean {
  return legacyReaderPaths.some((root) => path === root || path.startsWith(`${root}/`));
}

export function blogArticleSlug(path: string): string | null {
  return /^\/posts\/([a-z0-9-]{1,200})$/.exec(path)?.[1] ?? null;
}

export function isPublicBlogDocument(path: string): boolean {
  return path === "/" || path === "/posts" || blogArticleSlug(path) !== null;
}

export function isInsidePath(path: string): boolean {
  return path === "/inside" || path.startsWith("/inside/");
}

export function insideLoginDestination(path: string | null): string {
  if (!path) return "/inside";
  return /^\/inside(?:\/(?:invite|posts)\/[^/]+|\/checkout\/[^/]+|\/me(?:\/orders)?|\/tiers)?$/.test(
    path,
  ) &&
    !path.split("/").some((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        return decoded === "." || decoded === ".." || /[\/\\?#]/.test(decoded);
      } catch {
        return true;
      }
    })
    ? path
    : "/inside";
}
