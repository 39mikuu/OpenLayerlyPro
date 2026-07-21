"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmActionButton } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";
import { ENTITLEMENT_KEYS, type EntitlementKey } from "@/modules/membership/entitlement-keys";

export type TierData = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  priceLabel: string;
  priceAmountMinor: number | null;
  stripePriceId: string | null;
  currency: string | null;
  level: number;
  durationDays: number;
  purchaseEnabled: boolean;
  isActive: boolean;
  sortOrder: number;
  entitlements: EntitlementKey[];
};

function TierEditor({
  tier,
  onSubmit,
  onDelete,
  submitLabel,
}: {
  tier: Partial<TierData>;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
  submitLabel: string;
}) {
  const [form, setForm] = useState({
    name: tier.name ?? "",
    slug: tier.slug ?? "",
    description: tier.description ?? "",
    priceLabel: tier.priceLabel ?? "",
    priceAmountMinor: tier.priceAmountMinor == null ? "" : String(tier.priceAmountMinor),
    stripePriceId: tier.stripePriceId ?? "",
    currency: tier.currency ?? "",
    level: tier.level ?? 10,
    durationDays: tier.durationDays ?? 31,
    purchaseEnabled: tier.purchaseEnabled ?? true,
    isActive: tier.isActive ?? true,
    sortOrder: tier.sortOrder ?? 0,
    entitlements: tier.entitlements ?? [],
    reason: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  async function run(fn: () => Promise<void>) {
    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>{t("admin.tiers.name")}</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>slug</Label>
          <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.tiers.price")}</Label>
          <Input
            placeholder="¥29 / 月"
            value={form.priceLabel}
            onChange={(e) => setForm({ ...form, priceLabel: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.tiers.level")}</Label>
          <Input
            type="number"
            value={form.level}
            onChange={(e) => setForm({ ...form, level: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.tiers.onlineAmount")}</Label>
          <Input
            type="number"
            min={1}
            placeholder="500"
            value={form.priceAmountMinor}
            onChange={(e) => setForm({ ...form, priceAmountMinor: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t("admin.tiers.onlineAmountHint")}</p>
        </div>
        <div className="space-y-1">
          <Label>{t("admin.tiers.currency")}</Label>
          <Input
            maxLength={3}
            placeholder="usd"
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value.toLowerCase() })}
          />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.tiers.stripePriceId")}</Label>
          <Input
            placeholder="price_..."
            value={form.stripePriceId}
            onChange={(e) => setForm({ ...form, stripePriceId: e.target.value.trim() })}
          />
          <p className="text-xs text-muted-foreground">{t("admin.tiers.stripePriceIdHint")}</p>
        </div>
        <div className="space-y-1">
          <Label>{t("admin.tiers.duration")}</Label>
          <Input
            type="number"
            value={form.durationDays}
            onChange={(e) => setForm({ ...form, durationDays: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.common.sortOrder")}</Label>
          <Input
            type="number"
            value={form.sortOrder}
            onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label>{t("admin.tiers.description")}</Label>
        <Input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      <div className="flex items-center gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={form.purchaseEnabled}
            onChange={(e) => setForm({ ...form, purchaseEnabled: e.target.checked })}
          />
          {t("admin.tiers.purchasable")}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
          {t("admin.common.enabled")}
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("admin.tiers.entitlements")}</legend>
        <p className="text-xs text-muted-foreground">{t("admin.tiers.entitlementsHint")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {ENTITLEMENT_KEYS.map((key) => (
            <label key={key} className="rounded-md border p-3 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={form.entitlements.includes(key)}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      entitlements: event.target.checked
                        ? [...form.entitlements, key]
                        : form.entitlements.filter((value) => value !== key),
                    })
                  }
                />
                {t(`entitlements.${key}.label`)}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t(`entitlements.${key}.description`)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <Label>{t("admin.tiers.auditReason")}</Label>
        <Input
          maxLength={500}
          value={form.reason}
          onChange={(event) => setForm({ ...form, reason: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">{t("admin.tiers.auditReasonHint")}</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={loading || !form.name || !form.slug || !form.priceLabel || !form.reason.trim()}
          onClick={() =>
            run(() =>
              onSubmit({
                ...form,
                description: form.description || null,
                priceAmountMinor: form.priceAmountMinor ? Number(form.priceAmountMinor) : null,
                stripePriceId: form.stripePriceId || null,
                currency: form.currency || null,
              }),
            )
          }
        >
          {submitLabel}
        </Button>
        {onDelete && tier.name && (
          <ConfirmActionButton
            actionLabel={t("admin.common.delete")}
            cancelLabel={t("admin.common.cancel")}
            closeLabel={t("admin.common.close")}
            confirmLabel={t("admin.common.delete")}
            description={t("admin.tiers.deleteDialogDescription", { name: tier.name })}
            disabled={loading}
            errorFallback={t("admin.common.deleteFailed")}
            loadingLabel={t("admin.common.deleting")}
            title={t("admin.tiers.deleteDialogTitle")}
            variant="destructive"
            onConfirm={onDelete}
          />
        )}
      </div>
    </div>
  );
}

export function TierManager({
  tiers,
  defaultCurrency,
}: {
  tiers: TierData[];
  defaultCurrency: string;
}) {
  const router = useRouter();
  const t = useT();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-4 max-w-2xl">
      {tiers.map((tier) => (
        <Card key={tier.id}>
          <CardHeader>
            <CardTitle className="text-base">
              {t("admin.tiers.cardTitle", { name: tier.name, level: tier.level })}
              {!tier.isActive && ` · ${t("admin.common.disabled")}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TierEditor
              tier={tier}
              submitLabel={t("admin.common.save")}
              onSubmit={async (data) => {
                await api(`/api/admin/tiers/${tier.id}`, { method: "PUT", body: data });
                router.refresh();
              }}
              onDelete={async () => {
                await api(`/api/admin/tiers/${tier.id}`, { method: "DELETE" });
                router.refresh();
              }}
            />
          </CardContent>
        </Card>
      ))}

      {showCreate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("admin.tiers.new")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TierEditor
              tier={{ currency: defaultCurrency }}
              submitLabel={t("admin.common.create")}
              onSubmit={async (data) => {
                await api("/api/admin/tiers", { method: "POST", body: data });
                setShowCreate(false);
                router.refresh();
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <Button onClick={() => setShowCreate(true)}>{t("admin.tiers.new")}</Button>
      )}
    </div>
  );
}
