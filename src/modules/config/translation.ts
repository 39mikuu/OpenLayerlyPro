import { z } from "zod";

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

export async function saveTranslationConfig(input: TranslationConfigInput): Promise<void> {
  const existing = (await getStoredGroup<TranslationConfigInput>(TRANSLATION_GROUP)) ?? {};
  const next: TranslationConfigInput = {
    enabled: input.enabled ?? existing.enabled ?? false,
    provider: input.provider ?? existing.provider ?? "openai-compatible",
    apiKey: nonEmpty(input.apiKey) ?? nonEmpty(existing.apiKey),
    model: preserveOrNormalize(input.model, existing.model),
    endpoint: preserveOrNormalize(input.endpoint, existing.endpoint, normalizeEndpoint),
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
