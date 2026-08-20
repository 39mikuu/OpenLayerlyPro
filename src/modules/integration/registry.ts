import { access } from "fs/promises";
import path from "path";

import { type DbClient, getDb } from "@/db";
import { getEnv } from "@/lib/env";
import {
  getOAuthProviderAdminView,
  getSmtpAdminView,
  getStorageAdminView,
  getStoredGroupSnapshots,
  getStripeAdminView,
  getTranslationAdminView,
  getTurnstileAdminView,
  type OAuthProviderConfigInput,
  oauthProviderGroupKey,
  SMTP_GROUP,
  type SmtpConfigInput,
  STORAGE_GROUP,
  type StorageConfigInput,
  STRIPE_GROUP,
  type StripeConfigInput,
  TRANSLATION_GROUP,
  type TranslationConfigInput,
  TURNSTILE_GROUP,
  type TurnstileConfigInput,
} from "@/modules/config";
import { sendTestEmail } from "@/modules/mail";
import { testStripeConnection } from "@/modules/payment/providers";
import { getSetting, getSettings } from "@/modules/site";
import {
  parsePublicSecuritySettings,
  PUBLIC_INTEGRATIONS_KEY,
} from "@/modules/site/public-security";
import { testS3Connection } from "@/modules/storage";

import type {
  Integration,
  IntegrationId,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./types";

function configSource(hasDbOverride: boolean): "database" | "environment" {
  return hasDbOverride ? "database" : "environment";
}

function hasStoredPublicIntegrationProvider(value: unknown, provider: string): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "provider" in item &&
        Reflect.get(item, "provider") === provider,
    )
  );
}

const smtpIntegration: Integration = {
  id: "smtp",
  kind: "service",
  async getStatus(context) {
    const snapshot = context
      ? await context.getStoredGroupSnapshot<SmtpConfigInput>(SMTP_GROUP)
      : undefined;
    const view = await getSmtpAdminView(snapshot);
    const configured = Boolean(view.host && view.from);
    return {
      id: "smtp",
      kind: "service",
      configured,
      enabled: configured,
      source: configSource(view.hasDbOverride),
    };
  },
  async test(ctx) {
    // sendTestEmail 自带「SMTP 未配置」守卫；失败抛错由端点交给 handleApiError。
    await sendTestEmail(ctx.adminEmail, ctx.locale);
  },
};

const storageIntegration: Integration = {
  id: "storage",
  kind: "service",
  async getStatus(context) {
    const snapshot = context
      ? await context.getStoredGroupSnapshot<StorageConfigInput>(STORAGE_GROUP)
      : undefined;
    const view = await getStorageAdminView(snapshot);
    let configured = view.s3Configured;
    if (view.driver === "local") {
      try {
        await access(path.resolve(getEnv().UPLOAD_DIR));
        configured = true;
      } catch {
        configured = false;
      }
    }
    return {
      id: "storage",
      kind: "service",
      configured,
      enabled: true,
      source: configSource(view.hasDbOverride),
      driver: view.driver,
    };
  },
  async test() {
    // 当前仅代表 S3/R2 连接测试（Put/Get/Delete）；testS3Connection 自带 s3Configured 守卫。
    // local 可写性由 getStatus() 覆盖，UI 不暴露 local 测试入口。
    await testS3Connection();
  },
};

const stripeIntegration: Integration = {
  id: "stripe",
  kind: "service",
  async getStatus(context) {
    const snapshot = context
      ? await context.getStoredGroupSnapshot<StripeConfigInput>(STRIPE_GROUP)
      : undefined;
    const view = await getStripeAdminView(snapshot);
    return {
      id: "stripe",
      kind: "service",
      configured: view.configured,
      enabled: view.enabled,
      source: view.hasDbOverride ? "database" : "none",
    };
  },
  async test() {
    await testStripeConnection();
  },
};

const turnstileIntegration: Integration = {
  id: "turnstile",
  kind: "service",
  async getStatus(context) {
    const snapshot = context
      ? await context.getStoredGroupSnapshot<TurnstileConfigInput>(TURNSTILE_GROUP)
      : undefined;
    const view = await getTurnstileAdminView(snapshot);
    return {
      id: "turnstile",
      kind: "service",
      configured: Boolean(view.siteKey && view.secretKeySet),
      enabled: view.enabled,
      source: configSource(view.hasDbOverride),
    };
  },
};

const translationIntegration: Integration = {
  id: "translation",
  kind: "service",
  async getStatus(context) {
    const snapshot = context
      ? await context.getStoredGroupSnapshot<TranslationConfigInput>(TRANSLATION_GROUP)
      : undefined;
    const view = await getTranslationAdminView(snapshot);
    return {
      id: "translation",
      kind: "service",
      configured: view.configured,
      enabled: view.enabled,
      source: view.hasDbOverride ? "database" : "none",
    };
  },
};

function publicAnalyticsIntegration(provider: "plausible" | "umami"): Integration {
  return {
    id: provider,
    kind: "service",
    async getStatus(context) {
      const storedPublicIntegrations = context
        ? await context.getSetting<unknown>(PUBLIC_INTEGRATIONS_KEY)
        : await getSetting<unknown>(PUBLIC_INTEGRATIONS_KEY);
      const hasStoredProvider = hasStoredPublicIntegrationProvider(
        storedPublicIntegrations,
        provider,
      );
      if (!hasStoredProvider) {
        return {
          id: provider,
          kind: "service",
          configured: false,
          enabled: false,
          source: "none",
        };
      }

      const state = parsePublicSecuritySettings({
        [PUBLIC_INTEGRATIONS_KEY]: storedPublicIntegrations ?? [],
      });
      const providerEntries = state.publicIntegrations.filter(
        (integration) => integration.provider === provider,
      );
      if (providerEntries.length > 0) {
        return {
          id: provider,
          kind: "service",
          configured: true,
          enabled: providerEntries.some((integration) => integration.enabled !== false),
          source: "database",
        };
      }

      return {
        id: provider,
        kind: "service",
        configured: false,
        enabled: false,
        source: "database",
        error: true,
      };
    },
  };
}

const plausibleIntegration = publicAnalyticsIntegration("plausible");
const umamiIntegration = publicAnalyticsIntegration("umami");

const oauthGoogleIntegration: Integration = {
  id: "oauth_google",
  kind: "service",
  async getStatus(context) {
    const snapshot = context
      ? await context.getStoredGroupSnapshot<OAuthProviderConfigInput>(
          oauthProviderGroupKey("google"),
        )
      : undefined;
    const view = await getOAuthProviderAdminView("google", snapshot);
    return {
      id: "oauth_google",
      kind: "service",
      configured: view.configured,
      enabled: view.enabled,
      source: view.hasDbOverride ? "database" : "none",
    };
  },
};

const oauthGithubIntegration: Integration = {
  id: "oauth_github",
  kind: "service",
  async getStatus(context) {
    const snapshot = context
      ? await context.getStoredGroupSnapshot<OAuthProviderConfigInput>(
          oauthProviderGroupKey("github"),
        )
      : undefined;
    const view = await getOAuthProviderAdminView("github", snapshot);
    return {
      id: "oauth_github",
      kind: "service",
      configured: view.configured,
      enabled: view.enabled,
      source: view.hasDbOverride ? "database" : "none",
    };
  },
};

const tunnelIntegration: Integration = {
  id: "tunnel",
  kind: "deployment",
  async getStatus() {
    const configured = Boolean(getEnv().CLOUDFLARE_TUNNEL_TOKEN?.trim());
    return {
      id: "tunnel",
      kind: "deployment",
      configured,
      enabled: configured,
      source: configured ? "environment" : "none",
    };
  },
};

export const integrations: Integration[] = [
  smtpIntegration,
  storageIntegration,
  stripeIntegration,
  turnstileIntegration,
  translationIntegration,
  plausibleIntegration,
  umamiIntegration,
  oauthGoogleIntegration,
  oauthGithubIntegration,
  tunnelIntegration,
];

/**
 * 具备连接测试能力的集成 id（静态，由描述符是否实现 test() 决定）。
 * 注意：仅表示「类型可测试」；UI 仍须结合 status.configured / driver 决定是否显示或启用按钮。
 */
export const testableIntegrationIds: IntegrationId[] = integrations
  .filter((integration) => integration.test)
  .map((integration) => integration.id);

const STATUS_CONFIG_GROUPS = [
  SMTP_GROUP,
  STORAGE_GROUP,
  STRIPE_GROUP,
  TURNSTILE_GROUP,
  TRANSLATION_GROUP,
  oauthProviderGroupKey("google"),
  oauthProviderGroupKey("github"),
] as const;

function createIntegrationStatusContext(db: DbClient): IntegrationStatusContext {
  const configSnapshotsPromise = getStoredGroupSnapshots(STATUS_CONFIG_GROUPS, db);
  const siteSettingsPromise = getSettings([PUBLIC_INTEGRATIONS_KEY], db);

  return {
    async getStoredGroupSnapshot<T>(group: string) {
      const result = (await configSnapshotsPromise).get(group);
      if (!result) return { value: null, revision: 0 };
      if (!result.ok) throw result.error;
      return result.snapshot as { value: Partial<T> | null; revision: number };
    },
    async getSetting<T>(key: string) {
      const settings = await siteSettingsPromise;
      return Object.prototype.hasOwnProperty.call(settings, key) ? (settings[key] as T) : null;
    },
  };
}

export async function getIntegrationStatuses(db: DbClient = getDb()): Promise<IntegrationStatus[]> {
  const context = createIntegrationStatusContext(db);
  return Promise.all(
    integrations.map(async (integration) => {
      try {
        return await integration.getStatus(context);
      } catch {
        return {
          id: integration.id,
          kind: integration.kind,
          configured: false,
          enabled: false,
          source: "none",
          error: true,
        };
      }
    }),
  );
}
