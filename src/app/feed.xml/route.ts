import { NextRequest } from "next/server";

import {
  buildPublicAtomFeed,
  isPublicAtomFeedNotModified,
  publicAtomFeedHeaders,
} from "@/modules/content/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const feed = await buildPublicAtomFeed();
    const headers = publicAtomFeedHeaders(feed);
    if (isPublicAtomFeedNotModified(request.headers, feed)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(feed.xml, { status: 200, headers });
  } catch (error) {
    console.error("[feed] failed to render public Atom feed", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
