import { notFound } from "next/navigation";

import { PostEditor } from "@/components/admin/post-editor";
import { Badge } from "@/components/ui/badge";
import { getPostById, listPostFiles } from "@/modules/content";
import { getT } from "@/modules/i18n/server";
import { listTiers } from "@/modules/membership";
import { getPostTaxonomy, listCategories, listTags } from "@/modules/taxonomy";

export const dynamic = "force-dynamic";

const STATUS_KEYS: Record<string, string> = {
  draft: "admin.posts.draft",
  published: "admin.posts.published",
  archived: "admin.posts.archived",
};

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await getPostById(id);
  if (!post) notFound();
  const [tiers, files, categories, tags, taxonomy] = await Promise.all([
    listTiers({ activeOnly: true }),
    listPostFiles(id),
    listCategories(),
    listTags(),
    getPostTaxonomy(id),
  ]);
  const t = await getT();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold flex items-center gap-2">
        {t("admin.posts.editTitle")} <Badge variant="outline">{t(STATUS_KEYS[post.status])}</Badge>
      </h1>
      <PostEditor
        post={{
          id: post.id,
          title: post.title,
          slug: post.slug,
          summary: post.summary,
          body: post.body,
          coverFileId: post.coverFileId,
          visibility: post.visibility,
          requiredTierId: post.requiredTierId,
          status: post.status,
          originalLocale: post.originalLocale,
        }}
        tiers={tiers.map((t) => ({ id: t.id, name: t.name, level: t.level }))}
        attachedFiles={files
          .filter((f) => f.link.kind === "image" || f.link.kind === "attachment")
          .map((f) => ({
            fileId: f.file.id,
            kind: f.link.kind,
            originalName: f.file.originalName,
            sizeBytes: f.file.sizeBytes,
          }))}
        categories={categories}
        tags={tags}
        selectedCategoryIds={taxonomy.categories.map((category) => category.id)}
        selectedTagIds={taxonomy.tags.map((tag) => tag.id)}
      />
    </div>
  );
}
