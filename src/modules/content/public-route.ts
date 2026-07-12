export function hasNonCanonicalPublicQuery(url: string): boolean {
  return new URL(url).search !== "";
}

export function publicNotFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
