import { NextRequest } from "next/server";

import {
  isPublicHttpResourceNotModified,
  publicXmlHeaders,
} from "@/modules/content/public-projection";
import { buildRobotsTxt, PUBLIC_ROBOTS_CONTENT_TYPE } from "@/modules/content/sitemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const robots = buildRobotsTxt();
    const headers = publicXmlHeaders(robots, PUBLIC_ROBOTS_CONTENT_TYPE);
    if (isPublicHttpResourceNotModified(request.headers, robots)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(robots.body, { status: 200, headers });
  } catch (error) {
    console.error("[robots] failed to render robots.txt", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
