import type { Metadata } from "next";

import { renderPostDetail } from "@/modules/blog/post-detail";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function InsideArticle({ params }: { params: Promise<{ slug: string }> }) {
  return renderPostDetail((await params).slug, true);
}
