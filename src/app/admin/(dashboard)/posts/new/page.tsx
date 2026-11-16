import { PostEditor } from "@/components/admin/post-editor";
import { getEnv } from "@/lib/env";
import { getBlogCopy } from "@/modules/blog/copy";
import { getT, resolveLocale } from "@/modules/i18n/server";
import { listTiers } from "@/modules/membership";
import { listCategories, listTags } from "@/modules/taxonomy";

export const dynamic = "force-dynamic";

export default async function NewPostPage() {
  const [tiers, categories, tags] = await Promise.all([
    listTiers({ activeOnly: true }),
    listCategories(),
    listTags(),
  ]);
  const t = await getT();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.posts.new")}</h1>
      <PostEditor
        blogCopy={getEnv().PERSONAL_BLOG_MODE ? getBlogCopy(await resolveLocale()) : undefined}
        post={null}
        tiers={tiers.map((t) => ({ id: t.id, name: t.name, level: t.level }))}
        attachedFiles={[]}
        categories={categories}
        tags={tags}
        selectedCategoryIds={[]}
        selectedTagIds={[]}
      />
    </div>
  );
}
