import { TaxonomyManager } from "@/components/admin/taxonomy-manager";
import { getT } from "@/modules/i18n/server";
import { listCategories, listTags } from "@/modules/taxonomy";

export const dynamic = "force-dynamic";

export default async function TaxonomyPage() {
  const [categories, tags, t] = await Promise.all([listCategories(), listTags(), getT()]);
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.taxonomy.title")}</h1>
      <TaxonomyManager categories={categories} tags={tags} />
    </div>
  );
}
