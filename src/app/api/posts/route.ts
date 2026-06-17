import { handleApiError, jsonOk } from "@/lib/api";
import { listPosts } from "@/modules/content";

export const runtime = "nodejs";

export async function GET() {
  try {
    const posts = await listPosts({ publishedOnly: true });
    // 列表只返回元信息，正文在详情页按权限返回
    return jsonOk(
      posts.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        summary: p.summary,
        coverFileId: p.coverFileId,
        visibility: p.visibility,
        requiredTierId: p.requiredTierId,
        publishedAt: p.publishedAt,
      })),
    );
  } catch (err) {
    return handleApiError(err);
  }
}
