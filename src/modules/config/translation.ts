import { z } from "zod";

import { ApiError } from "@/lib/api";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

export const TRANSLATION_GROUP = "translation";

export const translationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(["openai-compatible"]).optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  endpoint: z.string().optional(),
  monthlyCharLimit: z.number().int().positive().nullable().optional(),
  directPublishEnabled: z.boolean().optional(),
  showMachineTranslationLabel: z.boolean().optional(),
});
export type TranslationConfigInput = z.infer<typeof translationConfigSchema>;

export type ResolvedTranslationConfig = {
  enabled: boolean;
  provider: "openai-compatible";
  apiKey?: string;
  model?: string;
  endpoint?: string;
  monthlyCharLimit?: number;
  directPublishEnabled: boolean;
  showMachineTranslationLabel: boolean;
  configured: boolean;
  hasDbOverride: boolean;
};

export type TranslationAdminView = Omit<ResolvedTranslationConfig, "apiKey"> & {
  apiKeySet: boolean;
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  return nonEmpty(value)?.replace(/\/+$/, "");
}

const LOOPBACK_OR_PRIVATE_HOST =
  /^(localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|[^.]+\.(localhost|local|internal|lan|home\.arpa))$/i;

// Strict validation runs only on the save path. Read paths keep the lenient
// normalizeEndpoint so a legacy stored value can never make config reads throw;
// the translation call itself still refuses redirects at fetch time.
export function validateTranslationEndpoint(value: string | undefined): string | undefined {
  const normalized = normalizeEndpoint(value);
  if (normalized === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new ApiError(400, "translationEndpointInvalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError(400, "translationEndpointInvalid");
  }
  if (url.username || url.password || url.hash || url.search) {
    // The endpoint is a base URL that gets /chat/completions appended; a
    // query string would swallow the appended path into its last value.
    throw new ApiError(400, "translationEndpointInvalid");
  }
  if (url.protocol === "http:" && !LOOPBACK_OR_PRIVATE_HOST.test(url.hostname)) {
    // Deliberate policy: plain-HTTP self-hosted endpoints (Ollama/LiteLLM on a
    // LAN) stay allowed, but a public-host HTTP endpoint sends the Bearer API
    // key in cleartext — surface it in the server log without blocking.
    console.warn(
      `translation endpoint uses plain HTTP on a public host (${url.hostname}); the API key will be sent unencrypted`,
    );
  }
  return normalized;
}

function preserveOrNormalize(
  input: string | undefined,
  existing: string | undefined,
  normalize: (value: string | undefined) => string | undefined = nonEmpty,
): string | undefined {
  return input === undefined ? normalize(existing) : normalize(input);
}

export async function getTranslationConfig(): Promise<ResolvedTranslationConfig> {
  const stored = await getStoredGroup<TranslationConfigInput>(TRANSLATION_GROUP);
  const provider = stored?.provider ?? "openai-compatible";
  const apiKey = nonEmpty(stored?.apiKey);
  const model = nonEmpty(stored?.model);
  const endpoint = normalizeEndpoint(stored?.endpoint);

  return {
    enabled: stored?.enabled ?? false,
    provider,
    apiKey,
    model,
    endpoint,
    monthlyCharLimit: stored?.monthlyCharLimit ?? undefined,
    directPublishEnabled: stored?.directPublishEnabled ?? false,
    showMachineTranslationLabel: stored?.showMachineTranslationLabel ?? false,
    configured: Boolean(apiKey && model && endpoint),
    hasDbOverride: stored !== null,
  };
}

export async function getTranslationAdminView(): Promise<TranslationAdminView> {
  const config = await getTranslationConfig();
  const { apiKey, ...safe } = config;
  return {
    ...safe,
    apiKeySet: Boolean(apiKey),
  };
}

// The admin form always resubmits the endpoint field, even when only other
// switches changed. A resubmitted value identical to what is already stored
// counts as unchanged and is preserved as-is (so a pre-validation legacy value
// can't block unrelated settings); strict validation runs only on real edits.
function resolveEndpointForSave(
  input: string | undefined,
  existing: string | undefined,
): string | undefined {
  if (input === undefined) return normalizeEndpoint(existing);
  const normalizedInput = normalizeEndpoint(input);
  const normalizedExisting = normalizeEndpoint(existing);
  if (normalizedInput !== undefined && normalizedInput === normalizedExisting) {
    return normalizedExisting;
  }
  return validateTranslationEndpoint(input);
}

export async function saveTranslationConfig(input: TranslationConfigInput): Promise<void> {
  const existing = (await getStoredGroup<TranslationConfigInput>(TRANSLATION_GROUP)) ?? {};
  const next: TranslationConfigInput = {
    enabled: input.enabled ?? existing.enabled ?? false,
    provider: input.provider ?? existing.provider ?? "openai-compatible",
    apiKey: nonEmpty(input.apiKey) ?? nonEmpty(existing.apiKey),
    model: preserveOrNormalize(input.model, existing.model),
    endpoint: resolveEndpointForSave(input.endpoint, existing.endpoint),
    monthlyCharLimit:
      input.monthlyCharLimit === undefined ? existing.monthlyCharLimit : input.monthlyCharLimit,
    directPublishEnabled: input.directPublishEnabled ?? existing.directPublishEnabled ?? false,
    showMachineTranslationLabel:
      input.showMachineTranslationLabel ?? existing.showMachineTranslationLabel ?? false,
  };

  for (const key of Object.keys(next) as (keyof TranslationConfigInput)[]) {
    if (next[key] === undefined) delete next[key];
  }

  await setStoredGroup<TranslationConfigInput>(TRANSLATION_GROUP, next);
}

export async function clearTranslationConfig(): Promise<void> {
  await deleteStoredGroup(TRANSLATION_GROUP);
}
