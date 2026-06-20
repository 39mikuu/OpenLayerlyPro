import { z } from "zod";

const envSchema = z.object({
  APP_URL: z.string().default("http://localhost:3000"),
  APP_NAME: z.string().default("Artist Member Site"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  SESSION_SECRET: z.string().default("change-me"),

  TURNSTILE_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),

  CONFIG_ENCRYPTION_KEY: z.string().optional(),
  CONFIG_ENCRYPTION_KEY_FILE: z.string().optional(),

  DATABASE_URL: z
    .string()
    .default("postgresql://artist:artist_password@localhost:5432/artist_member"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  UPLOAD_DIR: z.string().default("./uploads"),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((v) => v === "true"),

  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(500),
  PAYMENT_PROOF_MAX_SIZE_MB: z.coerce.number().default(10),
  INLINE_UPLOAD_GRACE_PERIOD_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  CLOUDFLARE_TUNNEL_TOKEN: z.string().optional(),

  // 反向代理 / 客户端 IP：默认不信任任何转发头（仅信任已配置的代理层）
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  TRUSTED_PROXY_HEADER: z
    .enum(["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip"])
    .default("x-forwarded-for"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * 运行时安全校验。`next build` 期间（NEXT_PHASE=phase-production-build）跳过，
 * 因为构建环境（CI / Docker build）没有真实 secret；运行时严格生效。
 */
function assertRuntimeSecurity(env: Env) {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  if (env.NODE_ENV === "production") {
    const secret = env.SESSION_SECRET;
    if (!secret || secret === "change-me" || secret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        "SESSION_SECRET must be set to a strong random value in production. " +
          "Generate one with: openssl rand -base64 32",
      );
    }
  }

  if (env.TURNSTILE_ENABLED && (!env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)) {
    throw new Error(
      "TURNSTILE_ENABLED=true 时必须同时配置 NEXT_PUBLIC_TURNSTILE_SITE_KEY 和 TURNSTILE_SECRET_KEY",
    );
  }
}

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量配置错误: ${parsed.error.message}`);
  }
  assertRuntimeSecurity(parsed.data);
  cached = parsed.data;
  return cached;
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === "production";
}
