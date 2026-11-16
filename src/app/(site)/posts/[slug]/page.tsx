import type { Metadata } from "next";

import { renderPostDetail } from "@/modules/blog/post-detail";
import { buildPublicPostMetadata } from "@/modules/content/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return buildPublicPostMetadata(slug);
}

export default async function PostDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  return renderPostDetail((await params).slug);
}
