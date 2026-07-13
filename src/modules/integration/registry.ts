import { access } from "fs/promises";
import path from "path";

import { getEnv } from "@/lib/env";
import {
  getSmtpAdminView,
  getStorageAdminView,
  getStripeAdminView,
  getTranslationAdminView,
  getTurnstileAdminView,
} from "@/modules/config";
import { sendTestEmail } from "@/modules/mail";
import { testStripeConnection } from "@/modules/payment/providers";
import { getSetting } from "@/modules/site";
import {
  parsePublicSecuritySettings,
  PUBLIC_INTEGRATIONS_KEY,
} from "@/modules/site/public-security";
import { testS3Connection } from "@/modules/storage";

import type { Integration, IntegrationId, IntegrationStatus } from "./types";

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
  async getStatus() {
    const view = await getSmtpAdminView();
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
  async getStatus() {
    const view = await getStorageAdminView();
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
  async getStatus() {
    const view = await getStripeAdminView();
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
  async getStatus() {
    const view = await getTurnstileAdminView();
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
  async getStatus() {
    const view = await getTranslationAdminView();
    return {
      id: "translation",
      kind: "service",
      configured: view.configured,
      enabled: view.enabled,
      source: view.hasDbOverride ? "database" : "none",
    };
  },
};

const umamiIntegration: Integration = {
  id: "umami",
  kind: "service",
  async getStatus() {
    const storedPublicIntegrations = await getSetting<unknown>(PUBLIC_INTEGRATIONS_KEY);
    const hasStoredUmami = hasStoredPublicIntegrationProvider(storedPublicIntegrations, "umami");
    if (!hasStoredUmami) {
      return {
        id: "umami",
        kind: "service",
        configured: false,
        enabled: false,
        source: "none",
      };
    }

    const state = parsePublicSecuritySettings({
      [PUBLIC_INTEGRATIONS_KEY]: storedPublicIntegrations ?? [],
    });
    const umamiEntries = state.publicIntegrations.filter(
      (integration) => integration.provider === "umami",
    );
    if (umamiEntries.length > 0) {
      return {
        id: "umami",
        kind: "service",
        configured: true,
        enabled: umamiEntries.some((integration) => integration.enabled !== false),
        source: "database",
      };
    }

    return {
      id: "umami",
      kind: "service",
      configured: false,
      enabled: false,
      source: "database",
      error: true,
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
  umamiIntegration,
  tunnelIntegration,
];

/**
 * 具备连接测试能力的集成 id（静态，由描述符是否实现 test() 决定）。
 * 注意：仅表示「类型可测试」；UI 仍须结合 status.configured / driver 决定是否显示或启用按钮。
 */
export const testableIntegrationIds: IntegrationId[] = integrations
  .filter((integration) => integration.test)
  .map((integration) => integration.id);

export async function getIntegrationStatuses(): Promise<IntegrationStatus[]> {
  return Promise.all(
    integrations.map(async (integration) => {
      try {
        return await integration.getStatus();
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
