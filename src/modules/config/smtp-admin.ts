import { getEnv } from "@/lib/env";

import { getSmtpConfig, SMTP_GROUP, type SmtpConfigInput } from "./smtp";
import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

/** 后台展示用的 SMTP 视图。password 永不外泄,只给 passwordSet 标志。 */
export type SmtpAdminView = {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  from?: string;
  passwordSet: boolean;
  /** app_settings 是否存在 smtp 行(true 表示当前由后台覆盖,而非纯环境变量)。 */
  hasDbOverride: boolean;
  /** 环境变量原值,供「从环境变量导入」填充表单。 */
  envDefaults: {
    host?: string;
    port: number;
    secure: boolean;
    user?: string;
    from?: string;
    passwordSet: boolean;
  };
};

export async function getSmtpAdminView(): Promise<SmtpAdminView> {
  const env = getEnv();
  const [effective, stored] = await Promise.all([
    getSmtpConfig(),
    getStoredGroup<SmtpConfigInput>(SMTP_GROUP),
  ]);
  return {
    host: effective.host,
    port: effective.port,
    secure: effective.secure,
    user: effective.user,
    from: effective.from,
    passwordSet: Boolean(effective.password),
    hasDbOverride: stored !== null,
    envDefaults: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      from: env.SMTP_FROM,
      passwordSet: Boolean(env.SMTP_PASSWORD),
    },
  };
}

/**
 * 保存 SMTP 配置到 app_settings。空字符串字段不落库(回落环境变量);
 * 密码留空表示不修改、保留原有 DB 密码(配合掩码,避免被清空)。
 */
export async function saveSmtpConfig(input: SmtpConfigInput): Promise<void> {
  const existing = (await getStoredGroup<SmtpConfigInput>(SMTP_GROUP)) ?? {};
  const next: SmtpConfigInput = {};
  if (input.host) next.host = input.host;
  if (input.from) next.from = input.from;
  if (input.user) next.user = input.user;
  if (input.port !== undefined) next.port = input.port;
  if (input.secure !== undefined) next.secure = input.secure;
  next.password = input.password ? input.password : existing.password;
  await setStoredGroup<SmtpConfigInput>(SMTP_GROUP, next);
}

/** 清除后台 SMTP 配置,整体回落到环境变量。 */
export async function clearSmtpConfig(): Promise<void> {
  await deleteStoredGroup(SMTP_GROUP);
}
