import { NextRequest } from "next/server";

import {
  isPublicHttpResourceNotModified,
  publicXmlHeaders,
} from "@/modules/content/public-projection";
import { buildSitemapIndexResource, PUBLIC_SITEMAP_CONTENT_TYPE } from "@/modules/content/sitemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const sitemap = await buildSitemapIndexResource();
    const headers = publicXmlHeaders(sitemap, PUBLIC_SITEMAP_CONTENT_TYPE);
    if (isPublicHttpResourceNotModified(request.headers, sitemap)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(sitemap.body, { status: 200, headers });
  } catch (error) {
    console.error("[sitemap] failed to render sitemap index", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
