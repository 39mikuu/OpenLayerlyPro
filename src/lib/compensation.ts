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

function findErrorIdentifier(error: Error): string | number | undefined {
  const seen = new Set<Error>();
  let current: Error | undefined = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") return code;

    const cause: unknown = (current as Error & { cause?: unknown }).cause;
    current = cause instanceof Error ? cause : undefined;
  }

  return undefined;
}

function summarizeError(error: unknown): ErrorSummary {
  if (!(error instanceof Error)) return { name: typeof error };

  const identifier = findErrorIdentifier(error);
  return {
    name: error.name,
    ...(identifier === undefined ? {} : { identifier }),
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
