import { PostEditor } from "@/components/admin/post-editor";
import { getT } from "@/modules/i18n/server";
import { listTiers } from "@/modules/membership";

export const dynamic = "force-dynamic";

export default async function NewPostPage() {
  const tiers = await listTiers({ activeOnly: true });
  const t = await getT();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.posts.new")}</h1>
      <PostEditor
        post={null}
        tiers={tiers.map((t) => ({ id: t.id, name: t.name, level: t.level }))}
        attachedFiles={[]}
      />
    </div>
  );
}
