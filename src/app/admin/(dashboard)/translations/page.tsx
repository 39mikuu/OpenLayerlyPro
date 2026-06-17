import { TranslationReviewList } from "@/components/admin/translation-review-list";
import { getT } from "@/modules/i18n/server";
import { listMachineTranslationDrafts } from "@/modules/translation/review";

export const dynamic = "force-dynamic";

export default async function AdminTranslationReviewsPage() {
  const [items, t] = await Promise.all([listMachineTranslationDrafts(), getT()]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">{t("admin.translations.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("admin.translations.description")}</p>
      </div>
      <TranslationReviewList
        items={items.map((item) => ({
          ...item,
          postUpdatedAt: item.postUpdatedAt.toISOString(),
          sourceUpdatedAt: item.sourceUpdatedAt?.toISOString() ?? null,
          translationUpdatedAt: item.translationUpdatedAt.toISOString(),
        }))}
      />
    </div>
  );
}
