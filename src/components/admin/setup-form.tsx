"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";

export function SetupForm() {
  const router = useRouter();
  const t = useT();
  const [form, setForm] = useState({
    siteName: "",
    artistName: "",
    artistBio: "",
    adminEmail: "",
    adminPassword: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      await api("/api/admin/setup", { method: "POST", body: form });
      await api("/api/auth/admin/login", {
        method: "POST",
        body: { email: form.adminEmail, password: form.adminPassword },
      });
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="siteName">{t("setup.siteName")}</Label>
        <Input
          id="siteName"
          value={form.siteName}
          onChange={(e) => set("siteName", e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="artistName">{t("setup.artistName")}</Label>
        <Input
          id="artistName"
          value={form.artistName}
          onChange={(e) => set("artistName", e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="artistBio">{t("setup.artistBio")}</Label>
        <Textarea
          id="artistBio"
          value={form.artistBio}
          onChange={(e) => set("artistBio", e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="adminEmail">{t("setup.adminEmail")}</Label>
        <Input
          id="adminEmail"
          type="email"
          value={form.adminEmail}
          onChange={(e) => set("adminEmail", e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="adminPassword">{t("setup.adminPassword")}</Label>
        <Input
          id="adminPassword"
          type="password"
          value={form.adminPassword}
          onChange={(e) => set("adminPassword", e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        className="w-full"
        disabled={
          loading ||
          !form.siteName ||
          !form.artistName ||
          !form.adminEmail ||
          form.adminPassword.length < 8
        }
        onClick={submit}
      >
        {loading ? t("setup.pending") : t("setup.submit")}
      </Button>
    </div>
  );
}
