import { z } from "zod";

import { getEnv } from "@/lib/env";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

export const UPLOAD_GROUP = "upload";

export const uploadConfigSchema = z.object({
  maxUploadSizeMb: z.number().int().positive().optional(),
  paymentProofMaxSizeMb: z.number().int().min(1).max(100).optional(),
});
export type UploadConfigInput = z.infer<typeof uploadConfigSchema>;

export type ResolvedUploadConfig = {
  maxUploadSizeMb: number;
  paymentProofMaxSizeMb: number;
};

export type UploadAdminView = {
  maxUploadSizeMb: number;
  paymentProofMaxSizeMb: number;
  paymentProofConfiguredMb: number;
  paymentProofIsClamped: boolean;
  hasDbOverride: boolean;
  envDefaults: {
    maxUploadSizeMb: number;
    paymentProofMaxSizeMb: number;
  };
};

function resolveUploadConfig(stored: UploadConfigInput): ResolvedUploadConfig {
  const env = getEnv();
  return {
    maxUploadSizeMb: stored.maxUploadSizeMb ?? env.MAX_UPLOAD_SIZE_MB,
    // The deployment env is the pre-DB multipart transfer ceiling. The admin
    // override may lower the business limit but cannot raise that hard ceiling.
    paymentProofMaxSizeMb: Math.min(
      stored.paymentProofMaxSizeMb ?? env.PAYMENT_PROOF_MAX_SIZE_MB,
      env.PAYMENT_PROOF_MAX_SIZE_MB,
    ),
  };
}

/** Resolve upload limits. Payment-proof settings cannot exceed the deployment ceiling. */
export async function getUploadConfig(): Promise<ResolvedUploadConfig> {
  const stored = (await getStoredGroup<UploadConfigInput>(UPLOAD_GROUP)) ?? {};
  return resolveUploadConfig(stored);
}

export async function getUploadAdminView(): Promise<UploadAdminView> {
  const env = getEnv();
  const [effective, stored] = await Promise.all([
    getUploadConfig(),
    getStoredGroup<UploadConfigInput>(UPLOAD_GROUP),
  ]);

  return {
    maxUploadSizeMb: effective.maxUploadSizeMb,
    paymentProofMaxSizeMb: effective.paymentProofMaxSizeMb,
    paymentProofConfiguredMb: stored?.paymentProofMaxSizeMb ?? env.PAYMENT_PROOF_MAX_SIZE_MB,
    paymentProofIsClamped:
      (stored?.paymentProofMaxSizeMb ?? env.PAYMENT_PROOF_MAX_SIZE_MB) >
      effective.paymentProofMaxSizeMb,
    hasDbOverride: stored !== null,
    envDefaults: {
      maxUploadSizeMb: env.MAX_UPLOAD_SIZE_MB,
      paymentProofMaxSizeMb: env.PAYMENT_PROOF_MAX_SIZE_MB,
    },
  };
}

export async function saveUploadConfig(input: UploadConfigInput): Promise<void> {
  const existing = (await getStoredGroup<UploadConfigInput>(UPLOAD_GROUP)) ?? {};
  const next: UploadConfigInput = {};

  next.maxUploadSizeMb = input.maxUploadSizeMb ?? existing.maxUploadSizeMb;
  next.paymentProofMaxSizeMb = input.paymentProofMaxSizeMb ?? existing.paymentProofMaxSizeMb;

  for (const key of Object.keys(next) as (keyof UploadConfigInput)[]) {
    if (next[key] === undefined) delete next[key];
  }

  await setStoredGroup<UploadConfigInput>(UPLOAD_GROUP, next);
}

export async function clearUploadConfig(): Promise<void> {
  await deleteStoredGroup(UPLOAD_GROUP);
}
