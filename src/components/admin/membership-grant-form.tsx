"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

export function MembershipGrantForm({ tiers }: { tiers: { id: string; name: string }[] }) {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState("");
  const [tierId, setTierId] = useState(tiers[0]?.id ?? "");
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="border rounded-lg p-4 space-y-3 max-w-xl">
      <h2 className="font-semibold text-sm">{t("admin.memberships.grantTitle")}</h2>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>{t("admin.memberships.fanEmail")}</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.memberships.tier")}</Label>
          <select
            className="border rounded-md h-9 px-2 w-full bg-transparent text-sm"
            value={tierId}
            onChange={(e) => setTierId(e.target.value)}
          >
            {tiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>{t("admin.memberships.days")}</Label>
          <Input type="number" value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>{t("admin.memberships.note")}</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <Button
        size="sm"
        disabled={loading || !email || !tierId}
        onClick={async () => {
          setLoading(true);
          setMessage(null);
          try {
            await api("/api/admin/memberships", {
              method: "POST",
              body: {
                userEmail: email,
                tierId,
                durationDays: days ? Number(days) : undefined,
                note: note || null,
              },
            });
            setMessage(t("admin.memberships.granted"));
            setEmail("");
            setNote("");
            setDays("");
            router.refresh();
          } catch (err) {
            setMessage(err instanceof Error ? err.message : t("admin.memberships.grantFailed"));
          } finally {
            setLoading(false);
          }
        }}
      >
        {t("admin.memberships.grant")}
      </Button>
    </div>
  );
}
