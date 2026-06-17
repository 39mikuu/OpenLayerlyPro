import { z } from "zod";

import { getEnv } from "@/lib/env";

import { getStoredGroup } from "./store";

export const SMTP_GROUP = "smtp";

/** 后台可写入的 SMTP 配置字段(全部可选,未设置的字段回落环境变量)。 */
export const smtpConfigSchema = z.object({
  host: z.string().optional(),
  port: z.coerce.number().int().positive().optional(),
  secure: z.boolean().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  from: z.string().optional(),
});
export type SmtpConfigInput = z.infer<typeof smtpConfigSchema>;

export type ResolvedSmtpConfig = {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from?: string;
  /** host 与 from 均有值时视为可用,与历史 isSmtpConfigured() 语义一致。 */
  configured: boolean;
};

/**
 * 解析最终生效的 SMTP 配置,优先级:DB(后台保存)＞ 环境变量 ＞ schema 默认。
 * app_settings 无 smtp 行时全程回落环境变量,与配置中心落地前行为一致。
 */
export async function getSmtpConfig(): Promise<ResolvedSmtpConfig> {
  const env = getEnv();
  const stored = (await getStoredGroup<SmtpConfigInput>(SMTP_GROUP)) ?? {};

  const host = stored.host ?? env.SMTP_HOST;
  const from = stored.from ?? env.SMTP_FROM;

  return {
    host,
    port: stored.port ?? env.SMTP_PORT,
    secure: stored.secure ?? env.SMTP_SECURE,
    user: stored.user ?? env.SMTP_USER,
    password: stored.password ?? env.SMTP_PASSWORD,
    from,
    configured: Boolean(host && from),
  };
}
