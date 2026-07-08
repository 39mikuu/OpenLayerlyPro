"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { IntegrationTestButton } from "@/components/admin/integration-test-button";
import { FormField, LoadingButton, Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
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
      <FormField id="stripe-currency" label={t("admin.stripe.currency")}>
        <Input
          id="stripe-currency"
          maxLength={3}
          value={currency}
          onChange={(event) => setCurrency(event.target.value.toLowerCase())}
          placeholder="usd"
        />
      </FormField>
      <FormField id="stripe-publishable-key" label={t("admin.stripe.publishableKey")}>
        <Input
          id="stripe-publishable-key"
          value={publishableKey}
          onChange={(event) => setPublishableKey(event.target.value)}
          placeholder="pk_test_..."
        />
      </FormField>
      <FormField id="stripe-secret-key" label={t("admin.stripe.secretKey")}>
        <Input
          id="stripe-secret-key"
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
      </FormField>
      <FormField id="stripe-webhook-secret" label={t("admin.stripe.webhookSecret")}>
        <Input
          id="stripe-webhook-secret"
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
      </FormField>
      <Notice>{t("admin.stripe.securityHint")}</Notice>
      {message && <Notice>{message}</Notice>}
      <div className="flex flex-wrap gap-2">
        <LoadingButton
          loading={loading}
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
        </LoadingButton>
        <LoadingButton
          variant="outline"
          loading={loading}
          disabled={!initial.hasDbOverride}
          onClick={() =>
            void run(
              () => api("/api/admin/config/stripe", { method: "DELETE" }),
              t("admin.stripe.cleared"),
            )
          }
        >
          {t("admin.stripe.clear")}
        </LoadingButton>
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
