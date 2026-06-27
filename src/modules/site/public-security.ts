import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { Parser } from "htmlparser2";
import { cache } from "react";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";

import { getDb } from "@/db";
import { files, siteSettings } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { getStorageConfig, type ResolvedStorageConfig } from "@/modules/config";
import {
  type CspSourceGroups,
  type EffectiveCspMode,
  exactHttpsOriginFromUrl,
  parseExactHttpsOrigin,
  resolveEffectiveCspMode,
  type SecurityCspMode,
} from "@/modules/security/csp";
import { resolveS3SignedDownloadOrigin } from "@/modules/storage/s3";

export const PUBLIC_CSP_REVISION_KEY = "public_csp_revision";
export const CUSTOM_FOOTER_MARKUP_KEY = "custom_footer_markup";
export const SITE_VERIFICATION_KEY = "site_verification";
export const PUBLIC_INTEGRATIONS_KEY = "public_integrations";
export const LEGACY_CUSTOM_FOOTER_KEY = "custom_footer_html";

export const PUBLIC_SECURITY_SETTING_KEYS = [
  PUBLIC_CSP_REVISION_KEY,
  CUSTOM_FOOTER_MARKUP_KEY,
  SITE_VERIFICATION_KEY,
  PUBLIC_INTEGRATIONS_KEY,
  LEGACY_CUSTOM_FOOTER_KEY,
] as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);
const exactHttpsUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => exactHttpsOriginFromUrl(value) !== null, "HTTPS URL required");
const exactOriginSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => parseExactHttpsOrigin(value) !== null, "Exact HTTPS origin required");
const originListSchema = z.array(exactOriginSchema).max(20).default([]);

const integrationCspSchema = z
  .object({
    script: originListSchema,
    connect: originListSchema,
    image: originListSchema,
    frame: originListSchema,
  })
  .strict()
  .default({ script: [], connect: [], image: [], frame: [] });

const dataAttributesSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), z.union([z.string().max(1000), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 20, "Too many data attributes")
  .default({});

const customIntegrationSchema = z
  .object({
    id: identifierSchema,
    provider: z.literal("custom"),
    enabled: z.boolean().default(true),
    placement: z.enum(["head", "body"]).default("head"),
    src: exactHttpsUrlSchema.optional(),
    inlineCode: z.string().max(20_000).optional(),
    async: z.boolean().optional(),
    defer: z.boolean().optional(),
    integrity: z
      .string()
      .max(512)
      .regex(/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
    crossOrigin: z.enum(["anonymous", "use-credentials"]).optional(),
    data: dataAttributesSchema,
    csp: integrationCspSchema,
  })
  .strict()
  .refine((value) => Boolean(value.src) !== Boolean(value.inlineCode), {
    message: "Custom integration requires exactly one of src or inlineCode",
  });

const plausibleIntegrationSchema = z
  .object({
    id: identifierSchema,
    provider: z.literal("plausible"),
    enabled: z.boolean().default(true),
    domain: z
      .string()
      .min(1)
      .max(253)
      .regex(
        /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
      ),
    scriptUrl: exactHttpsUrlSchema.default("https://plausible.io/js/script.js"),
    apiOrigin: exactOriginSchema.default("https://plausible.io"),
  })
  .strict();

const knownVerificationSchema = z
  .object({
    provider: z.enum(["google", "bing", "yandex"]),
    content: z.string().min(1).max(1000),
  })
  .strict();
const customVerificationSchema = z
  .object({
    provider: z.literal("custom"),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/)
      .refine((name) => name.toLowerCase() !== "http-equiv"),
    content: z.string().min(1).max(1000),
  })
  .strict();
export const siteVerificationSchema = z
  .array(z.discriminatedUnion("provider", [knownVerificationSchema, customVerificationSchema]))
  .max(20);

type PlausibleIntegration = z.infer<typeof plausibleIntegrationSchema>;
type CustomIntegration = z.infer<typeof customIntegrationSchema>;
export type PublicIntegration = PlausibleIntegration | CustomIntegration;
export type SiteVerification = z.infer<typeof siteVerificationSchema>;
export type LegacyFooterStatus = "empty" | "safe_markup" | "needs_migration";

export type IntegrationRenderPlan = {
  id: string;
  placement: "head" | "body";
  src?: string;
  inlineCode?: string;
  async?: boolean;
  defer?: boolean;
  integrity?: string;
  crossOrigin?: "anonymous" | "use-credentials";
  data: Record<string, string | boolean>;
};

type IntegrationAdapterRuntime = {
  plan: IntegrationRenderPlan;
  sources: Pick<CspSourceGroups, "script" | "image" | "connect" | "frame">;
};

const PUBLIC_INTEGRATION_ADAPTERS = {
  plausible: {
    schema: plausibleIntegrationSchema,
    build(integration: PlausibleIntegration): IntegrationAdapterRuntime | null {
      const scriptOrigin = exactHttpsOriginFromUrl(integration.scriptUrl);
      const apiOrigin = parseExactHttpsOrigin(integration.apiOrigin);
      if (!scriptOrigin || !apiOrigin) return null;
      return {
        plan: {
          id: integration.id,
          placement: "head",
          src: integration.scriptUrl,
          defer: true,
          data: { domain: integration.domain, api: `${apiOrigin}/api/event` },
        },
        sources: {
          script: [scriptOrigin],
          image: [],
          connect: [apiOrigin],
          frame: [],
        },
      };
    },
  },
  custom: {
    schema: customIntegrationSchema,
    build(integration: CustomIntegration): IntegrationAdapterRuntime {
      const srcOrigin = integration.src ? exactHttpsOriginFromUrl(integration.src) : null;
      return {
        plan: {
          id: integration.id,
          placement: integration.placement,
          src: integration.src,
          inlineCode: integration.inlineCode,
          async: integration.async,
          defer: integration.defer,
          integrity: integration.integrity,
          crossOrigin: integration.crossOrigin,
          data: integration.data,
        },
        sources: {
          script: [...(srcOrigin ? [srcOrigin] : []), ...integration.csp.script],
          image: integration.csp.image,
          connect: integration.csp.connect,
          frame: integration.csp.frame,
        },
      };
    },
  },
} as const;

export const publicIntegrationSchema = z.unknown().transform<PublicIntegration>((value, ctx) => {
  const provider =
    typeof value === "object" && value !== null && "provider" in value
      ? Reflect.get(value, "provider")
      : null;
  if (
    typeof provider !== "string" ||
    !Object.prototype.hasOwnProperty.call(PUBLIC_INTEGRATION_ADAPTERS, provider)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Unknown public integration provider",
      path: ["provider"],
    });
    return z.NEVER;
  }
  const adapter = PUBLIC_INTEGRATION_ADAPTERS[provider as keyof typeof PUBLIC_INTEGRATION_ADAPTERS];
  const parsed = adapter.schema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return parsed.data as PublicIntegration;
});
export const publicIntegrationsSchema = z
  .array(publicIntegrationSchema)
  .max(20)
  .superRefine((items, ctx) => {
    const ids = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Integration ids must be unique",
          path: [index, "id"],
        });
      }
      ids.add(item.id);
    }
  });

export type VerificationMeta = {
  name: string;
  content: string;
};

export type PublicSecurityState = {
  revision: string;
  configuredMode: "auto" | "report-only" | "enforce";
  effectiveMode: EffectiveCspMode;
  customFooterMarkup: string;
  legacyFooterHtml: string;
  legacyFooterStatus: LegacyFooterStatus;
  footerHtml: string;
  siteVerification: SiteVerification;
  publicIntegrations: PublicIntegration[];
  configurationErrors: string[];
};

export type PublicCspRuntimeConfig = PublicSecurityState & {
  integrationPlans: IntegrationRenderPlan[];
  verificationMeta: VerificationMeta[];
  sources: CspSourceGroups;
  storageSources: string[];
};

export type PublicRenderConfig = PublicSecurityState & {
  integrationPlans: IntegrationRenderPlan[];
  verificationMeta: VerificationMeta[];
};

const FOOTER_ALLOWED_TAGS = [
  "a",
  "br",
  "span",
  "div",
  "p",
  "small",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
] as const;
const FOOTER_ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ["href", "target", "rel", "title"],
  div: ["class"],
  span: ["class"],
  p: ["class"],
  small: ["class"],
};

const FOOTER_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...FOOTER_ALLOWED_TAGS],
  allowedAttributes: Object.fromEntries(
    Object.entries(FOOTER_ALLOWED_ATTRIBUTES).map(([tag, attributes]) => [tag, [...attributes]]),
  ),
  allowedClasses: {
    div: ["*"],
    span: ["*"],
    p: ["*"],
    small: ["*"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { a: ["http", "https", "mailto"] },
  allowProtocolRelative: false,
  enforceHtmlBoundary: true,
  transformTags: {
    a: (_tagName, attribs) => {
      const target = attribs.target === "_blank" ? "_blank" : undefined;
      return {
        tagName: "a",
        attribs: {
          ...attribs,
          ...(target ? { target, rel: "noopener noreferrer" } : {}),
        },
      };
    },
  },
};

export function sanitizeFooterMarkup(value: string): string {
  return sanitizeHtml(value, FOOTER_SANITIZE_OPTIONS);
}

function isSafeFooterHref(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed) || trimmed.startsWith("//")) {
    return false;
  }
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("?")
  ) {
    return true;
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed)) return true;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function classifyLegacyFooter(value: string): LegacyFooterStatus {
  if (!value.trim()) return "empty";
  const allowedTags = new Set<string>(FOOTER_ALLOWED_TAGS);
  let unsafe = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (!allowedTags.has(name)) {
          unsafe = true;
          return;
        }
        const allowedAttributes = new Set(FOOTER_ALLOWED_ATTRIBUTES[name] ?? []);
        for (const [attribute, attributeValue] of Object.entries(attributes)) {
          if (!allowedAttributes.has(attribute)) {
            unsafe = true;
            continue;
          }
          if (attribute === "href" && !isSafeFooterHref(attributeValue)) unsafe = true;
          if (attribute === "target" && attributeValue !== "_blank") unsafe = true;
        }
      },
      onclosetag(name) {
        if (!allowedTags.has(name)) unsafe = true;
      },
      onprocessinginstruction() {
        unsafe = true;
      },
    },
    {
      decodeEntities: true,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
      recognizeSelfClosing: true,
    },
  );
  try {
    parser.end(value);
  } catch {
    return "needs_migration";
  }
  return unsafe ? "needs_migration" : "safe_markup";
}

function parseStoredValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
  errors: string[],
  fallback: T,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  errors.push(`${label}: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`);
  return fallback;
}

function settingString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildFooterHtml(input: {
  customFooterMarkup: string;
  legacyFooterHtml: string;
  legacyFooterStatus: LegacyFooterStatus;
  effectiveMode: EffectiveCspMode;
}): string {
  if (input.legacyFooterStatus === "needs_migration" && input.effectiveMode === "report-only") {
    return [input.customFooterMarkup, input.legacyFooterHtml].filter(Boolean).join("\n");
  }
  if (input.customFooterMarkup) return input.customFooterMarkup;
  return input.legacyFooterStatus === "safe_markup"
    ? sanitizeFooterMarkup(input.legacyFooterHtml)
    : "";
}

export function parsePublicSecuritySettings(
  settings: Record<string, unknown>,
  configuredModeOverride?: SecurityCspMode,
): PublicSecurityState {
  const errors: string[] = [];
  const customFooterMarkup = sanitizeFooterMarkup(
    settingString(settings[CUSTOM_FOOTER_MARKUP_KEY]),
  );
  const legacyFooterHtml = settingString(settings[LEGACY_CUSTOM_FOOTER_KEY]);
  const legacyFooterStatus = classifyLegacyFooter(legacyFooterHtml);
  const publicIntegrations = parseStoredValue(
    publicIntegrationsSchema,
    settings[PUBLIC_INTEGRATIONS_KEY] ?? [],
    PUBLIC_INTEGRATIONS_KEY,
    errors,
    [],
  );
  const siteVerification = parseStoredValue(
    siteVerificationSchema,
    settings[SITE_VERIFICATION_KEY] ?? [],
    SITE_VERIFICATION_KEY,
    errors,
    [],
  );
  const configuredMode = configuredModeOverride ?? getEnv().SECURITY_CSP_MODE;
  const effectiveMode = resolveEffectiveCspMode(
    configuredMode,
    legacyFooterStatus === "needs_migration",
  );
  const revision = settingString(settings[PUBLIC_CSP_REVISION_KEY]) || "unversioned";

  return {
    revision,
    configuredMode,
    effectiveMode,
    customFooterMarkup,
    legacyFooterHtml,
    legacyFooterStatus,
    footerHtml: buildFooterHtml({
      customFooterMarkup,
      legacyFooterHtml,
      legacyFooterStatus,
      effectiveMode,
    }),
    siteVerification,
    publicIntegrations,
    configurationErrors: errors,
  };
}

export function buildVerificationMeta(settings: SiteVerification): VerificationMeta[] {
  const names = {
    google: "google-site-verification",
    bing: "msvalidate.01",
    yandex: "yandex-verification",
  } as const;
  return settings.map((item) => ({
    name: item.provider === "custom" ? item.name : names[item.provider],
    content: item.content,
  }));
}

function normalizeOrigins(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => parseExactHttpsOrigin(value))
        .filter((value): value is string => !!value),
    ),
  ].sort();
}

export function buildIntegrationRuntime(integrations: PublicIntegration[]): {
  plans: IntegrationRenderPlan[];
  sources: CspSourceGroups;
} {
  const plans: IntegrationRenderPlan[] = [];
  const sources: CspSourceGroups = { script: [], image: [], media: [], connect: [], frame: [] };
  const script: string[] = [];
  const image: string[] = [];
  const connect: string[] = [];
  const frame: string[] = [];

  for (const integration of integrations) {
    if (!integration.enabled) continue;
    const adapter = PUBLIC_INTEGRATION_ADAPTERS[integration.provider];
    const runtime = adapter.build(integration as never);
    if (!runtime) continue;
    plans.push(runtime.plan);
    script.push(...runtime.sources.script);
    image.push(...runtime.sources.image);
    connect.push(...runtime.sources.connect);
    frame.push(...runtime.sources.frame);
  }

  return {
    plans,
    sources: {
      ...sources,
      script: normalizeOrigins(script),
      image: normalizeOrigins(image),
      connect: normalizeOrigins(connect),
      frame: normalizeOrigins(frame),
    },
  };
}

export function escapeInlineScriptBody(value: string): string {
  return value
    .replace(/<\/script/giu, "<\\/script")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

export function canRenderIntegrationRevision(
  requestRevision: string | null,
  currentRevision: string,
  nonce: string | null,
): boolean {
  return Boolean(nonce && requestRevision === currentRevision);
}

async function readSettings(): Promise<Record<string, unknown>> {
  const rows = await getDb()
    .select({ key: siteSettings.key, valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...PUBLIC_SECURITY_SETTING_KEYS]));
  return Object.fromEntries(rows.map((row) => [row.key, row.valueJson]));
}

let lastLegacyWarningAt = 0;

function warnAboutConfiguration(state: PublicSecurityState): void {
  const now = Date.now();
  if (now - lastLegacyWarningAt < 60_000) return;
  if (state.legacyFooterStatus === "needs_migration") {
    console.warn(
      `[security] legacy custom footer requires migration; browser CSP mode is ${state.effectiveMode}`,
    );
    lastLegacyWarningAt = now;
  } else if (state.configurationErrors.length > 0) {
    console.error(
      `[security] invalid public security configuration: ${state.configurationErrors.join("; ")}`,
    );
    lastLegacyWarningAt = now;
  }
}

export async function readPublicSecurityState(): Promise<PublicSecurityState> {
  const state = parsePublicSecuritySettings(await readSettings());
  warnAboutConfiguration(state);
  return state;
}

export async function resolveStorageCspSources(
  storage: Pick<
    ResolvedStorageConfig,
    | "driver"
    | "endpoint"
    | "region"
    | "bucket"
    | "accessKeyId"
    | "secretAccessKey"
    | "forcePathStyle"
    | "s3Configured"
  >,
  historicalBuckets: readonly string[] = [],
): Promise<string[]> {
  if (
    !storage.s3Configured ||
    !storage.endpoint ||
    !storage.bucket ||
    !storage.accessKeyId ||
    !storage.secretAccessKey
  ) {
    return [];
  }
  const buckets = [...new Set([storage.bucket, ...historicalBuckets.filter(Boolean)])];
  const origins = await Promise.all(
    buckets.map((bucket) =>
      resolveS3SignedDownloadOrigin({
        endpoint: storage.endpoint!,
        region: storage.region,
        bucket,
        accessKeyId: storage.accessKeyId!,
        secretAccessKey: storage.secretAccessKey!,
        forcePathStyle: storage.forcePathStyle,
      }),
    ),
  );
  return [...new Set(origins.filter((origin): origin is string => Boolean(origin)))].sort();
}

export async function getConfiguredStorageCspSources(): Promise<string[]> {
  const storage = await getStorageConfig();
  if (!storage.s3Configured) return [];
  const historicalBuckets = await getDb()
    .selectDistinct({ bucket: files.bucket })
    .from(files)
    .where(eq(files.storageDriver, "s3"));
  return resolveStorageCspSources(
    storage,
    historicalBuckets
      .map((row) => row.bucket)
      .filter((bucket): bucket is string => Boolean(bucket)),
  );
}

async function readPublicRenderConfig(): Promise<PublicRenderConfig> {
  const state = await readPublicSecurityState();
  const integration = buildIntegrationRuntime(state.publicIntegrations);
  return {
    ...state,
    integrationPlans: integration.plans,
    verificationMeta: buildVerificationMeta(state.siteVerification),
  };
}

export const getPublicRenderConfig = cache(readPublicRenderConfig);

export async function getPublicCspRuntimeConfig(): Promise<PublicCspRuntimeConfig> {
  const renderConfig = await readPublicRenderConfig();
  const integration = buildIntegrationRuntime(renderConfig.publicIntegrations);
  const storageSources: string[] = [];
  try {
    storageSources.push(...(await getConfiguredStorageCspSources()));
  } catch (error) {
    console.error("[security] failed to derive S3 signed resource origin", error);
  }

  return {
    ...renderConfig,
    integrationPlans: integration.plans,
    sources: {
      script: integration.sources.script,
      image: [...integration.sources.image, ...storageSources],
      media: storageSources,
      connect: integration.sources.connect,
      frame: integration.sources.frame,
    },
    storageSources,
  };
}

type PublicSecurityUpdate = {
  expectedRevision?: string;
  customFooterMarkup?: string;
  siteVerification?: SiteVerification;
  publicIntegrations?: PublicIntegration[];
  legacyAction?: "migrate-safe" | "clear";
  additionalSettings?: Record<string, unknown>;
  deleteSettingKeys?: readonly string[];
};

async function upsertSetting(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  key: string,
  value: unknown,
): Promise<void> {
  await tx
    .insert(siteSettings)
    .values({ key, valueJson: value })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { valueJson: value, updatedAt: new Date() },
    });
}

export async function updatePublicSecuritySettings(update: PublicSecurityUpdate): Promise<void> {
  const customFooterMarkup =
    update.customFooterMarkup === undefined
      ? undefined
      : sanitizeFooterMarkup(update.customFooterMarkup);
  const siteVerification =
    update.siteVerification === undefined
      ? undefined
      : siteVerificationSchema.parse(update.siteVerification);
  const publicIntegrations =
    update.publicIntegrations === undefined
      ? undefined
      : publicIntegrationsSchema.parse(update.publicIntegrations);

  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('openlayerlypro:public-security-settings', 0))`,
    );
    if (update.expectedRevision !== undefined) {
      const [revisionRow] = await tx
        .select({ valueJson: siteSettings.valueJson })
        .from(siteSettings)
        .where(eq(siteSettings.key, PUBLIC_CSP_REVISION_KEY))
        .limit(1);
      const currentRevision = settingString(revisionRow?.valueJson) || "unversioned";
      if (currentRevision !== update.expectedRevision) {
        throw new ApiError(409, "publicSecurityRevisionConflict");
      }
    }

    for (const key of update.deleteSettingKeys ?? []) {
      await tx.delete(siteSettings).where(eq(siteSettings.key, key));
    }
    for (const [key, value] of Object.entries(update.additionalSettings ?? {})) {
      await upsertSetting(tx, key, value);
    }

    if (customFooterMarkup !== undefined) {
      await upsertSetting(tx, CUSTOM_FOOTER_MARKUP_KEY, customFooterMarkup);
    }
    if (siteVerification !== undefined) {
      await upsertSetting(tx, SITE_VERIFICATION_KEY, siteVerification);
    }
    if (publicIntegrations !== undefined) {
      await upsertSetting(tx, PUBLIC_INTEGRATIONS_KEY, publicIntegrations);
    }

    if (update.legacyAction === "migrate-safe") {
      const [legacy] = await tx
        .select({ valueJson: siteSettings.valueJson })
        .from(siteSettings)
        .where(eq(siteSettings.key, LEGACY_CUSTOM_FOOTER_KEY))
        .limit(1);
      const original = settingString(legacy?.valueJson);
      if (classifyLegacyFooter(original) !== "safe_markup") {
        throw new ApiError(409, "legacyFooterRequiresManualMigration");
      }
      const [target] = await tx
        .select({ valueJson: siteSettings.valueJson })
        .from(siteSettings)
        .where(eq(siteSettings.key, CUSTOM_FOOTER_MARKUP_KEY))
        .limit(1);
      const migrated = sanitizeFooterMarkup(original);
      const existingTarget = settingString(target?.valueJson);
      if (existingTarget && existingTarget !== migrated) {
        throw new ApiError(409, "legacyFooterMigrationTargetNotEmpty");
      }
      await upsertSetting(tx, CUSTOM_FOOTER_MARKUP_KEY, migrated);
      await tx.delete(siteSettings).where(eq(siteSettings.key, LEGACY_CUSTOM_FOOTER_KEY));
    } else if (update.legacyAction === "clear") {
      await tx.delete(siteSettings).where(eq(siteSettings.key, LEGACY_CUSTOM_FOOTER_KEY));
    }

    if (
      customFooterMarkup !== undefined ||
      siteVerification !== undefined ||
      publicIntegrations !== undefined ||
      update.legacyAction !== undefined
    ) {
      await upsertSetting(tx, PUBLIC_CSP_REVISION_KEY, randomUUID());
    }
  });
}
