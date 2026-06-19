"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

type TaxonomyData = { id: string; name: string; slug: string; sortOrder?: number };

function TaxonomyEditor({
  item,
  kind,
  onDone,
}: {
  item?: TaxonomyData;
  kind: "categories" | "tags";
  onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(item?.name ?? "");
  const [slug, setSlug] = useState(item?.slug ?? "");
  const [sortOrder, setSortOrder] = useState(item?.sortOrder ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setLoading(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  const endpoint = `/api/admin/${kind}${item ? `/${item.id}` : ""}`;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>{t("admin.taxonomy.name")}</Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.taxonomy.slug")}</Label>
          <Input
            value={slug}
            placeholder={t("admin.taxonomy.slugPlaceholder")}
            onChange={(event) => setSlug(event.target.value)}
          />
        </div>
        {kind === "categories" && (
          <div className="space-y-1">
            <Label>{t("admin.common.sortOrder")}</Label>
            <Input
              type="number"
              value={sortOrder}
              onChange={(event) => setSortOrder(Number(event.target.value))}
            />
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={loading || !name}
          onClick={() =>
            run(() =>
              api(endpoint, {
                method: item ? "PUT" : "POST",
                body: {
                  name,
                  ...(slug ? { slug } : {}),
                  ...(kind === "categories" ? { sortOrder } : {}),
                },
              }),
            )
          }
        >
          {item ? t("admin.common.save") : t("admin.common.create")}
        </Button>
        {item && (
          <Button
            size="sm"
            variant="destructive"
            disabled={loading}
            onClick={() => {
              if (!confirm(t("admin.taxonomy.confirmDelete", { name: item.name }))) return;
              void run(() => api(endpoint, { method: "DELETE" }));
            }}
          >
            {t("admin.common.delete")}
          </Button>
        )}
      </div>
    </div>
  );
}

function TaxonomySection({
  title,
  kind,
  items,
}: {
  title: string;
  kind: "categories" | "tags";
  items: TaxonomyData[];
}) {
  const router = useRouter();
  const t = useT();
  const [creating, setCreating] = useState(false);
  const done = () => {
    setCreating(false);
    router.refresh();
  };

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {items.map((item) => (
        <Card key={item.id}>
          <CardHeader>
            <CardTitle className="text-base">{item.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <TaxonomyEditor item={item} kind={kind} onDone={done} />
          </CardContent>
        </Card>
      ))}
      {creating ? (
        <Card>
          <CardContent className="pt-6">
            <TaxonomyEditor kind={kind} onDone={done} />
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" onClick={() => setCreating(true)}>
          {t(kind === "categories" ? "admin.taxonomy.newCategory" : "admin.taxonomy.newTag")}
        </Button>
      )}
    </section>
  );
}

export function TaxonomyManager({
  categories,
  tags,
}: {
  categories: TaxonomyData[];
  tags: TaxonomyData[];
}) {
  const t = useT();
  return (
    <div className="grid max-w-5xl gap-8 lg:grid-cols-2">
      <TaxonomySection
        title={t("admin.taxonomy.categories")}
        kind="categories"
        items={categories}
      />
      <TaxonomySection title={t("admin.taxonomy.tags")} kind="tags" items={tags} />
    </div>
  );
}
