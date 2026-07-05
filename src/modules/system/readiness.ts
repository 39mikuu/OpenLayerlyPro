import { sql } from "drizzle-orm";

import { getDb } from "@/db";
import { getEnv, isProduction } from "@/lib/env";
import { getIntegrationStatuses, type IntegrationId } from "@/modules/integration";
import {
  getConfigEncryptionKey,
  isConfigEncryptionKeyConfigured,
} from "@/modules/security/config-key";

/** 可选集成的就绪探测结果（信息性，绝不参与 ready 门禁）。 */
export type IntegrationProbe = {
  id: IntegrationId;
  enabled: boolean;
  /** 启用的集成是否配置完整且无读取错误；未启用的集成视为健康。 */
  healthy: boolean;
};

export type Readiness = {
  ready: boolean;
  checks: {
    database: boolean;
    config: boolean;
    encryptionKey: boolean;
  };
  warnings?: string[];
  /** 仅在显式请求（includeIntegrations）时出现；不影响 ready。 */
  integrations?: IntegrationProbe[];
};

const PROCESS_LOCAL_LIMITER_WARNING =
  "APP_INSTANCE_COUNT is greater than 1, but v1.0 rate limits are process-local and not globally consistent across replicas.";

/**
 * 就绪检查，供 /api/ready 使用（反向代理 / 负载均衡探活）。
 * 只返回粗粒度布尔结果，不暴露任何 secret 或错误细节。
 * 可选的集成探测仅为信息性，绝不进入 ready 门禁——Core 必须在所有可选集成关闭/未配置时仍就绪。
 */
export async function getReadiness(options?: {
  includeIntegrations?: boolean;
}): Promise<Readiness> {
  let config = false;
  const warnings: string[] = [];
  try {
    const env = getEnv();
    config = true;
    if (env.APP_INSTANCE_COUNT > 1) {
      warnings.push(PROCESS_LOCAL_LIMITER_WARNING);
    }
  } catch {
    config = false;
  }

  let database = false;
  if (config) {
    try {
      await getDb().execute(sql`select 1`);
      database = true;
    } catch {
      database = false;
    }
  }

  // 生产环境必须存在可用的配置加密根密钥；
  // 开发/测试环境允许缺省，但若已配置来源则必须可读取。
  let encryptionKey = false;
  if (config) {
    try {
      if (isConfigEncryptionKeyConfigured()) {
        encryptionKey = getConfigEncryptionKey() !== null;
      } else {
        encryptionKey = !isProduction();
      }
    } catch {
      encryptionKey = false;
    }
  }

  const readiness: Readiness = {
    ready: database && config && encryptionKey,
    checks: { database, config, encryptionKey },
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  // 可选集成探测：仅在显式请求且基础配置可读时执行；探测失败不影响 ready，省略字段即可。
  if (options?.includeIntegrations && config) {
    try {
      const statuses = await getIntegrationStatuses();
      readiness.integrations = statuses.map((status) => ({
        id: status.id,
        enabled: status.enabled,
        healthy: !status.error && (!status.enabled || status.configured),
      }));
    } catch {
      // 信息性探测，失败时静默省略 integrations。
    }
  }

  return readiness;
}
