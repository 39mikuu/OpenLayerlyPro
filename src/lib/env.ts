import { z } from "zod";

const envSchema = z.object({
  APP_URL: z.string().default("http://localhost:3000"),
  APP_NAME: z.string().default("Artist Member Site"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_INSTANCE_COUNT: z.coerce.number().int().min(1).max(1_000).default(1),

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
  EMAIL_RETRY_RECHECK_MINUTES: z.coerce.number().finite().int().min(1).max(1_440).default(15),
  EMAIL_DELIVERY_MAX_AGE_HOURS: z.coerce.number().finite().int().min(1).max(168).default(24),

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
  PAYMENT_PROOF_MAX_SIZE_MB: z.coerce.number().finite().int().min(1).max(100).default(10),
  PAYMENT_PROOF_RETENTION_DAYS: z.coerce.number().finite().int().min(1).max(3650).default(30),
  PAYMENT_PROOF_MAX_PER_DAY: z.coerce.number().finite().int().min(1).max(1000).default(20),
  PROOF_UPLOAD_RESERVATION_TTL_MINUTES: z.coerce.number().finite().int().min(1).max(60).default(5),
  REQUEST_JSON_MAX_BYTES: z.coerce
    .number()
    .finite()
    .int()
    .min(1_024)
    .max(1_048_576)
    .default(65_536),
  STRIPE_WEBHOOK_MAX_BYTES: z.coerce
    .number()
    .finite()
    .int()
    .min(1_024)
    .max(1_048_576)
    .default(262_144),
  SUBSCRIPTION_RECONCILE_INTERVAL_MINUTES: z.coerce
    .number()
    .finite()
    .int()
    .min(5)
    .max(10_080)
    .default(60),
  SUBSCRIPTION_REMINDER_LEAD_DAYS: z.coerce.number().finite().int().min(1).max(90).default(7),
  IMAGE_MAX_FRAMES: z.coerce.number().finite().int().min(1).max(2_000).default(300),
  IMAGE_MAX_TOTAL_PIXELS: z.coerce
    .number()
    .finite()
    .int()
    .min(1_000_000)
    .max(2_000_000_000)
    .default(300_000_000),
  INLINE_UPLOAD_GRACE_PERIOD_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(21_600),
  FILE_PREAUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(100).max(100_000).default(1_200),
  FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .min(2_000)
    .max(1_000_000)
    .default(20_000),
  FILE_PREAUTH_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(86_400_000)
    .default(600_000),
  VIDEO_RANGE_RATE_LIMIT_MAX: z.coerce.number().int().min(50).max(10_000).default(600),
  VIDEO_UNRESOLVED_RATE_LIMIT_MAX: z.coerce.number().int().min(1_000).max(500_000).default(10_000),
  VIDEO_RANGE_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(86_400_000)
    .default(600_000),
  DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX: z.coerce.number().int().min(500).max(100_000).default(2_000),

  ADMIN_LOGIN_RATE_MAX: z.coerce.number().int().min(1).max(1_000).default(10),
  ADMIN_LOGIN_UNRESOLVED_RATE_MAX: z.coerce.number().int().min(10).max(100_000).default(100),
  ADMIN_LOGIN_RATE_WINDOW_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(600_000),
  VERIFY_CODE_IP_RATE_MAX: z.coerce.number().int().min(1).max(10_000).default(30),
  VERIFY_CODE_EMAIL_IP_RATE_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
  VERIFY_CODE_UNRESOLVED_RATE_MAX: z.coerce.number().int().min(30).max(1_000_000).default(300),
  VERIFY_CODE_RATE_WINDOW_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(600_000),
  REQUEST_CODE_IP_RATE_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
  REQUEST_CODE_EMAIL_IP_RATE_MAX: z.coerce.number().int().min(1).max(10_000).default(5),
  REQUEST_CODE_UNRESOLVED_RATE_MAX: z.coerce.number().int().min(20).max(1_000_000).default(100),
  REQUEST_CODE_RATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(86_400_000)
    .default(3_600_000),
  REQUEST_CODE_SEND_DEDUPE_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  LOGIN_CODE_LENGTH: z.coerce.number().int().min(16).max(64).default(16),
  LOGIN_CODE_ALPHABET: z.enum(["crockford-base32"]).default("crockford-base32"),

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
