"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, uploadFile } from "@/lib/client";

type MethodData = {
  id: string;
  name: string;
  description: string | null;
  qrFileId: string | null;
  isActive: boolean;
  sortOrder: number;
};

function MethodEditor({
  method,
  onSubmit,
  onDelete,
  submitLabel,
}: {
  method: Partial<MethodData>;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
  submitLabel: string;
}) {
  const [form, setForm] = useState({
    name: method.name ?? "",
    description: method.description ?? "",
    qrFileId: method.qrFileId ?? null,
    isActive: method.isActive ?? true,
    sortOrder: method.sortOrder ?? 0,
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
          <Label>{t("admin.paymentMethods.name")}</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
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
        <Label>{t("admin.paymentMethods.description")}</Label>
        <Textarea
          rows={2}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin.paymentMethods.qr")}</Label>
        {form.qrFileId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/files/${form.qrFileId}/download`}
            alt={t("admin.paymentMethods.qrAlt")}
            className="w-40 h-40 object-contain border rounded-md"
          />
        )}
        <Input
          type="file"
          accept=".jpg,.jpeg,.png,.webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            run(async () => {
              const record = await uploadFile<{ id: string }>("/api/admin/files/upload", file, {
                purpose: "payment_qr",
              });
              setForm((f) => ({ ...f, qrFileId: record.id }));
            });
          }}
        />
      </div>
      <label className="flex items-center gap-1 text-sm">
        <input
          type="checkbox"
          checked={form.isActive}
          onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
        />
        {t("admin.common.enabled")}
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={loading || !form.name}
          onClick={() => run(() => onSubmit({ ...form, description: form.description || null }))}
        >
          {submitLabel}
        </Button>
        {onDelete && (
          <Button size="sm" variant="destructive" disabled={loading} onClick={() => run(onDelete)}>
            {t("admin.common.delete")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function PaymentMethodManager({ methods }: { methods: MethodData[] }) {
  const router = useRouter();
  const t = useT();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-4 max-w-xl">
      {methods.map((method) => (
        <Card key={method.id}>
          <CardHeader>
            <CardTitle className="text-base">
              {method.name}
              {!method.isActive && ` · ${t("admin.common.disabled")}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MethodEditor
              method={method}
              submitLabel={t("admin.common.save")}
              onSubmit={async (data) => {
                await api(`/api/admin/payment-methods/${method.id}`, { method: "PUT", body: data });
                router.refresh();
              }}
              onDelete={async () => {
                if (!confirm(t("admin.paymentMethods.confirmDelete", { name: method.name })))
                  return;
                await api(`/api/admin/payment-methods/${method.id}`, { method: "DELETE" });
                router.refresh();
              }}
            />
          </CardContent>
        </Card>
      ))}

      {showCreate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("admin.paymentMethods.new")}</CardTitle>
          </CardHeader>
          <CardContent>
            <MethodEditor
              method={{}}
              submitLabel={t("admin.common.create")}
              onSubmit={async (data) => {
                await api("/api/admin/payment-methods", { method: "POST", body: data });
                setShowCreate(false);
                router.refresh();
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <Button onClick={() => setShowCreate(true)}>{t("admin.paymentMethods.new")}</Button>
      )}
    </div>
  );
}
