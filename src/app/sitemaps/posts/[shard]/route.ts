import { NextRequest } from "next/server";

import {
  isPublicHttpResourceNotModified,
  publicXmlHeaders,
} from "@/modules/content/public-projection";
import {
  buildPostSitemapShardResource,
  PUBLIC_SITEMAP_CONTENT_TYPE,
} from "@/modules/content/sitemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHARD_PARAM_PATTERN = /^\d+\.xml$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ shard: string }> },
) {
  try {
    const { shard } = await params;
    if (!SHARD_PARAM_PATTERN.test(shard)) {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
    const sitemap = await buildPostSitemapShardResource({
      shard: Number(shard.replace(/\.xml$/, "")),
    });
    if (!sitemap) {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
    const headers = publicXmlHeaders(sitemap, PUBLIC_SITEMAP_CONTENT_TYPE);
    if (isPublicHttpResourceNotModified(request.headers, sitemap)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(sitemap.body, { status: 200, headers });
  } catch (error) {
    console.error("[sitemap] failed to render post sitemap shard", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
