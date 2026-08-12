import { createHash } from "crypto";

import { logger } from "@/lib/logger";

type CompensationStep = {
  operation: string;
  run: () => void | Promise<void>;
};

type ErrorSummary = {
  name: string;
  identifier?: string | number;
};

function summarizeError(error: unknown): ErrorSummary {
  if (!(error instanceof Error)) return { name: typeof error };

  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name,
    ...(typeof code === "string" || typeof code === "number" ? { identifier: code } : {}),
  };
}

export function opaqueCompensationResourceId(...parts: Array<string | null>): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\0"))
    .digest("hex");
}

/**
 * Runs every immediate compensation step without allowing a cleanup failure to
 * replace the error that made compensation necessary. Cleanup failures remain
 * observable through structured logs. Durable reconciliation is intentionally
 * outside this immediate-compensation helper.
 */
export async function compensateAndPreserveError<T>(
  primaryError: T,
  steps: CompensationStep[],
  context: Record<string, unknown> = {},
): Promise<T> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (cleanupError) {
      logger.error("Compensation step failed", {
        ...context,
        operation: step.operation,
        primaryError: summarizeError(primaryError),
        cleanupError: summarizeError(cleanupError),
      });
    }
  }

  return primaryError;
}
