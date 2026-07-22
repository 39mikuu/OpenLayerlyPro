import { createHash, randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { Parser } from "htmlparser2";
import { cache } from "react";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";

import { getDb } from "@/db";
import { files, siteSettings } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { type AuditActor, recordAudit } from "@/modules/audit";
import { getStorageConfig, type ResolvedStorageConfig } from "@/modules/config";
import { lockSiteFileSettingReferences } from "@/modules/file/references";
import {
  type CspSourceGroups,
  type EffectiveCspMode,
  exactHttpsOriginFromUrl,
  parseExactHttpsOrigin,
  resolveEffectiveCspMode,
  type SecurityCspMode,
} from "@/modules/security/csp";
import {
  PUBLIC_INTEGRATION_EXACT_PATHS,
  PUBLIC_INTEGRATION_PATH_PREFIXES,
} from "@/modules/site/public-integration-paths";
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
const LEGACY_PLAUSIBLE_DEFAULT_SCRIPT_URL = "https://plausible.io/js/script.js";
const PLAUSIBLE_DEFAULT_MANUAL_SCRIPT_URL = "https://plausible.io/js/script.manual.js";
const PLAUSIBLE_PRIVATE_URL_EXTENSION_SEGMENTS = new Set([
  "outbound-links",
  "file-downloads",
  "tagged-events",
]);

function normalizePlausibleScriptUrl(value: unknown): unknown {
  return value === LEGACY_PLAUSIBLE_DEFAULT_SCRIPT_URL
    ? PLAUSIBLE_DEFAULT_MANUAL_SCRIPT_URL
    : value;
}

const plausibleManualScriptUrlSchema = z
  .preprocess(normalizePlausibleScriptUrl, exactHttpsUrlSchema)
  .refine((value) => {
    try {
      const filename = new URL(value).pathname.split("/").pop() ?? "";
      const segments = filename.split(".");
      return (
        filename.endsWith(".js") &&
        segments.includes("manual") &&
        !segments.some((segment) => PLAUSIBLE_PRIVATE_URL_EXTENSION_SEGMENTS.has(segment))
      );
    } catch {
      return false;
    }
  }, "Plausible manual tracker URL required");
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
    scriptUrl: plausibleManualScriptUrlSchema.default(PLAUSIBLE_DEFAULT_MANUAL_SCRIPT_URL),
    apiOrigin: exactOriginSchema.default("https://plausible.io"),
  })
  .strict();

const umamiWebsiteIdSchema = z.string().uuid();
const umamiIntegrationSchema = z
  .object({
    id: identifierSchema,
    provider: z.literal("umami"),
    enabled: z.boolean().default(true),
    websiteId: umamiWebsiteIdSchema,
    scriptUrl: exactHttpsUrlSchema.default("https://cloud.umami.is/script.js"),
    apiOrigin: exactOriginSchema.optional(),
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
type UmamiIntegration = z.infer<typeof umamiIntegrationSchema>;
type CustomIntegration = z.infer<typeof customIntegrationSchema>;
export type PublicIntegration = PlausibleIntegration | UmamiIntegration | CustomIntegration;
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
  plan?: IntegrationRenderPlan;
  plans?: IntegrationRenderPlan[];
  sources: Pick<CspSourceGroups, "script" | "image" | "connect" | "frame">;
};

// JSON embedded in inline <script> source must be escaped for the JS/HTML
// context (</script> breakout, U+2028/U+2029 line terminators) even though
// the path constants are compile-time values — CodeQL js/bad-code-sanitization.
function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildUmamiPublicPageTrackerInlineCode(): string {
  const exact = jsonForInlineScript(
    Object.fromEntries(PUBLIC_INTEGRATION_EXACT_PATHS.map((path) => [path, 1])),
  );
  const prefixes = jsonForInlineScript([...PUBLIC_INTEGRATION_PATH_PREFIXES]);
  return `(function(){var e=${exact};var r=${prefixes};var l="";function m(p){if(e[p])return true;for(var i=0;i<r.length;i++){if(p.indexOf(r[i])===0)return true;}return false;}function t(){var p=location.pathname;var u=p+location.search;if(!m(p)){l="";return;}if(u===l)return;if(!window.umami||typeof window.umami.track!=="function")return;l=u;window.umami.track(function(d){return Object.assign({},d,{url:location.pathname+location.search,title:document.title,referrer:document.referrer});});}var h=history;var p=h.pushState;var q=h.replaceState;if(p)h.pushState=function(){var v=p.apply(this,arguments);t();return v;};if(q)h.replaceState=function(){var v=q.apply(this,arguments);t();return v;};window.addEventListener("popstate",t);window.addEventListener("load",t);})();`;
}

function buildPlausiblePublicPageTrackerInlineCode(): string {
  const exact = jsonForInlineScript(
    Object.fromEntries(PUBLIC_INTEGRATION_EXACT_PATHS.map((path) => [path, 1])),
  );
  const prefixes = jsonForInlineScript([...PUBLIC_INTEGRATION_PATH_PREFIXES]);
  return `(function(){var e=${exact};var r=${prefixes};var l="";var p=window.plausible=window.plausible||function(){(p.q=p.q||[]).push(arguments);};function m(v){if(e[v])return true;for(var i=0;i<r.length;i++){if(v.indexOf(r[i])===0)return true;}return false;}function t(){var v=location.pathname;var u=v+location.search;if(!m(v)){l="";return;}if(u===l)return;l=u;window.plausible("pageview",{url:location.origin+u});}var h=history;var a=h.pushState;var b=h.replaceState;if(a)h.pushState=function(){var v=a.apply(this,arguments);t();return v;};if(b)h.replaceState=function(){var v=b.apply(this,arguments);t();return v;};window.addEventListener("popstate",t);window.addEventListener("load",t);})();`;
}

const PUBLIC_INTEGRATION_ADAPTERS = {
  plausible: {
    schema: plausibleIntegrationSchema,
    build(integration: PlausibleIntegration): IntegrationAdapterRuntime | null {
      const scriptOrigin = exactHttpsOriginFromUrl(integration.scriptUrl);
      const apiOrigin = parseExactHttpsOrigin(integration.apiOrigin);
      if (!scriptOrigin || !apiOrigin) return null;
      const apiEndpoint = `${apiOrigin}/api/event`;
      return {
        plans: [
          {
            id: integration.id,
            placement: "head",
            src: integration.scriptUrl,
            defer: true,
            data: { domain: integration.domain, api: apiEndpoint },
          },
          {
            id: `${integration.id}-manual-pageview`,
            placement: "head",
            inlineCode: buildPlausiblePublicPageTrackerInlineCode(),
            data: {},
          },
        ],
        sources: {
          script: [scriptOrigin],
          image: [],
          connect: [apiOrigin],
          frame: [],
        },
      };
    },
  },
  umami: {
    schema: umamiIntegrationSchema,
    build(integration: UmamiIntegration): IntegrationAdapterRuntime | null {
      const scriptOrigin = exactHttpsOriginFromUrl(integration.scriptUrl);
      const apiOrigin = integration.apiOrigin
        ? parseExactHttpsOrigin(integration.apiOrigin)
        : scriptOrigin;
      if (!scriptOrigin || !apiOrigin) return null;
      return {
        plans: [
          {
            id: integration.id,
            placement: "head",
            src: integration.scriptUrl,
            defer: true,
            data: {
              "website-id": integration.websiteId,
              "auto-track": "false",
              // Emit host-url whenever apiOrigin is explicit: without it the
              // tracker derives the endpoint from the script directory, so a
              // same-origin subpath script (/stats/script.js) would post to
              // /stats/api/send instead of /api/send.
              ...(integration.apiOrigin ? { "host-url": apiOrigin } : {}),
            },
          },
          {
            id: `${integration.id}-manual-pageview`,
            placement: "head",
            inlineCode: buildUmamiPublicPageTrackerInlineCode(),
            data: {},
          },
        ],
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
    const enabledAnalyticsProviders = new Set<"plausible" | "umami">();
    for (const [index, item] of items.entries()) {
      if (item.id.endsWith("-manual-pageview")) {
        ctx.addIssue({
          code: "custom",
          message: "Integration ids must not end with -manual-pageview",
          path: [index, "id"],
        });
      }
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Integration ids must be unique",
          path: [index, "id"],
        });
      }
      ids.add(item.id);
      if (item.enabled !== false && (item.provider === "plausible" || item.provider === "umami")) {
        if (enabledAnalyticsProviders.has(item.provider)) {
          ctx.addIssue({
            code: "custom",
            message: `Only one enabled ${item.provider} integration is supported`,
            path: [index, "provider"],
          });
        }
        enabledAnalyticsProviders.add(item.provider);
      }
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
    plans.push(...(runtime.plans ?? (runtime.plan ? [runtime.plan] : [])));
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
  actor: AuditActor;
  expectedRevision?: string;
  customFooterMarkup?: string;
  siteVerification?: SiteVerification;
  publicIntegrations?: PublicIntegration[];
  legacyAction?: "migrate-safe" | "clear";
  additionalSettings?: Record<string, unknown>;
  deleteSettingKeys?: readonly string[];
};

type SiteSettingsTx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

const PUBLIC_SECURITY_SETTINGS_AUDIT_ENTITY_ID = "00000000-0000-4000-8000-000000000164";
const PUBLIC_SECURITY_AUDIT_SETTING_KEYS = [
  CUSTOM_FOOTER_MARKUP_KEY,
  SITE_VERIFICATION_KEY,
  PUBLIC_INTEGRATIONS_KEY,
  LEGACY_CUSTOM_FOOTER_KEY,
] as const;

type PublicSecurityAuditSettingKey = (typeof PUBLIC_SECURITY_AUDIT_SETTING_KEYS)[number];

async function upsertSetting(tx: SiteSettingsTx, key: string, value: unknown): Promise<void> {
  await tx
    .insert(siteSettings)
    .values({ key, valueJson: value })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { valueJson: value, updatedAt: new Date() },
    });
}

async function readAuditSettingValues(tx: SiteSettingsTx): Promise<Map<string, unknown>> {
  const rows = await tx
    .select({ key: siteSettings.key, valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...PUBLIC_SECURITY_AUDIT_SETTING_KEYS]));
  return new Map(rows.map((row) => [row.key, row.valueJson]));
}

function auditHash(value: unknown): string {
  const normalized = normalizeAuditJson(value);
  return createHash("sha256")
    .update(JSON.stringify(normalized) ?? String(normalized))
    .digest("hex")
    .slice(0, 16);
}

function normalizeAuditJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeAuditJson(item));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeAuditJson(item)]),
  );
}

function summarizeMarkupAudit(value: unknown): Record<string, unknown> {
  const markup = settingString(value);
  return {
    configured: markup.length > 0,
    length: markup.length,
    contentHash: markup ? auditHash(markup) : null,
  };
}

function summarizeLegacyMarkupAudit(value: unknown): Record<string, unknown> {
  const markup = settingString(value);
  return {
    present: markup.length > 0,
    status: classifyLegacyFooter(markup),
    length: markup.length,
    contentHash: markup ? auditHash(markup) : null,
  };
}

function summarizeVerificationAudit(value: unknown): unknown {
  const parsed = siteVerificationSchema.safeParse(value ?? []);
  if (!parsed.success) return { invalid: true };
  return parsed.data.map((item) => ({
    provider: item.provider,
    ...(item.provider === "custom" ? { name: item.name } : {}),
    contentHash: auditHash(item.content),
  }));
}

function summarizeIntegrationAudit(value: unknown): unknown {
  const parsed = publicIntegrationsSchema.safeParse(value ?? []);
  if (!parsed.success) return { invalid: true };
  return parsed.data.map((integration) => ({
    provider: integration.provider,
    id: integration.id,
    enabled: integration.enabled,
    configHash: auditHash(integration),
  }));
}

function summarizeAuditSetting(key: PublicSecurityAuditSettingKey, value: unknown): unknown {
  switch (key) {
    case CUSTOM_FOOTER_MARKUP_KEY:
      return summarizeMarkupAudit(value);
    case SITE_VERIFICATION_KEY:
      return summarizeVerificationAudit(value);
    case PUBLIC_INTEGRATIONS_KEY:
      return summarizeIntegrationAudit(value);
    case LEGACY_CUSTOM_FOOTER_KEY:
      return summarizeLegacyMarkupAudit(value);
  }
}

function buildChangedAuditSnapshot(
  beforeValues: Map<string, unknown>,
  afterValues: Map<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of PUBLIC_SECURITY_AUDIT_SETTING_KEYS) {
    const beforeValue = summarizeAuditSetting(key, beforeValues.get(key));
    const afterValue = summarizeAuditSetting(key, afterValues.get(key));
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
    before[key] = beforeValue;
    after[key] = afterValue;
  }
  return Object.keys(after).length > 0 ? { before, after } : null;
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

    await lockSiteFileSettingReferences(tx, update.additionalSettings ?? {});
    const beforeAuditValues = await readAuditSettingValues(tx);
    const afterAuditValues = new Map(beforeAuditValues);

    for (const key of update.deleteSettingKeys ?? []) {
      await tx.delete(siteSettings).where(eq(siteSettings.key, key));
      if ((PUBLIC_SECURITY_AUDIT_SETTING_KEYS as readonly string[]).includes(key)) {
        afterAuditValues.delete(key);
      }
    }
    for (const [key, value] of Object.entries(update.additionalSettings ?? {})) {
      await upsertSetting(tx, key, value);
      if ((PUBLIC_SECURITY_AUDIT_SETTING_KEYS as readonly string[]).includes(key)) {
        afterAuditValues.set(key, value);
      }
    }

    if (customFooterMarkup !== undefined) {
      await upsertSetting(tx, CUSTOM_FOOTER_MARKUP_KEY, customFooterMarkup);
      afterAuditValues.set(CUSTOM_FOOTER_MARKUP_KEY, customFooterMarkup);
    }
    if (siteVerification !== undefined) {
      await upsertSetting(tx, SITE_VERIFICATION_KEY, siteVerification);
      afterAuditValues.set(SITE_VERIFICATION_KEY, siteVerification);
    }
    if (publicIntegrations !== undefined) {
      await upsertSetting(tx, PUBLIC_INTEGRATIONS_KEY, publicIntegrations);
      afterAuditValues.set(PUBLIC_INTEGRATIONS_KEY, publicIntegrations);
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
      afterAuditValues.set(CUSTOM_FOOTER_MARKUP_KEY, migrated);
      afterAuditValues.delete(LEGACY_CUSTOM_FOOTER_KEY);
    } else if (update.legacyAction === "clear") {
      await tx.delete(siteSettings).where(eq(siteSettings.key, LEGACY_CUSTOM_FOOTER_KEY));
      afterAuditValues.delete(LEGACY_CUSTOM_FOOTER_KEY);
    }

    if (
      customFooterMarkup !== undefined ||
      siteVerification !== undefined ||
      publicIntegrations !== undefined ||
      update.legacyAction !== undefined
    ) {
      await upsertSetting(tx, PUBLIC_CSP_REVISION_KEY, randomUUID());
    }
    const auditSnapshot = buildChangedAuditSnapshot(beforeAuditValues, afterAuditValues);
    if (auditSnapshot) {
      await recordAudit(tx, {
        entityType: "public_security_settings",
        entityId: PUBLIC_SECURITY_SETTINGS_AUDIT_ENTITY_ID,
        action: "public_security_settings_updated",
        actor: update.actor,
        before: auditSnapshot.before,
        after: auditSnapshot.after,
        correlationId: randomUUID(),
      });
    }
  });
}
