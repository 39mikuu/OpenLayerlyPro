"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { IntegrationTestButton } from "@/components/admin/integration-test-button";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";
import type { StripeAdminView } from "@/modules/config";

export function StripeConfigForm({ initial }: { initial: StripeAdminView }) {
  const router = useRouter();
  const t = useT();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [currency, setCurrency] = useState(initial.currency);
  const [publishableKey, setPublishableKey] = useState(initial.publishableKey ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<void>, success: string) {
    setLoading(true);
    setMessage(null);
    try {
      await action();
      setSecretKey("");
      setWebhookSecret("");
      setMessage(success);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <Label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("admin.stripe.enable")}
      </Label>
      <div className="space-y-2">
        <Label>{t("admin.stripe.currency")}</Label>
        <Input
          maxLength={3}
          value={currency}
          onChange={(event) => setCurrency(event.target.value.toLowerCase())}
          placeholder="usd"
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin.stripe.publishableKey")}</Label>
        <Input
          value={publishableKey}
          onChange={(event) => setPublishableKey(event.target.value)}
          placeholder="pk_test_..."
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin.stripe.secretKey")}</Label>
        <Input
          type="password"
          autoComplete="new-password"
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          placeholder={
            initial.secretKeySet
              ? t("admin.stripe.secretSet")
              : t("admin.stripe.secretKeyPlaceholder")
          }
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin.stripe.webhookSecret")}</Label>
        <Input
          type="password"
          autoComplete="new-password"
          value={webhookSecret}
          onChange={(event) => setWebhookSecret(event.target.value)}
          placeholder={
            initial.webhookSecretSet
              ? t("admin.stripe.secretSet")
              : t("admin.stripe.webhookSecretPlaceholder")
          }
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("admin.stripe.securityHint")}</p>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={loading}
          onClick={() =>
            void run(
              () =>
                api("/api/admin/config/stripe", {
                  method: "PUT",
                  body: {
                    enabled,
                    currency,
                    publishableKey,
                    secretKey,
                    webhookSecret,
                  },
                }),
              t("admin.common.saved"),
            )
          }
        >
          {t("admin.common.save")}
        </Button>
        <Button
          variant="outline"
          disabled={loading || !initial.hasDbOverride}
          onClick={() =>
            void run(
              () => api("/api/admin/config/stripe", { method: "DELETE" }),
              t("admin.stripe.cleared"),
            )
          }
        >
          {t("admin.stripe.clear")}
        </Button>
        <IntegrationTestButton
          integrationId="stripe"
          disabled={!initial.configured}
          label={t("admin.stripe.test")}
          pendingLabel={t("admin.integrationTest.pending")}
          successText={t("admin.stripe.testSuccess")}
        />
      </div>
    </div>
  );
}
