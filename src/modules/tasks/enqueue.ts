import { sql } from "drizzle-orm";

import { type DbClient } from "@/db";
import { tasks } from "@/db/schema";

export const DEFAULT_MAX_ATTEMPTS = 5;

export async function enqueueTask(
  tx: DbClient,
  input: {
    kind: string;
    dedupeKey?: string | null;
    payload: Record<string, unknown>;
    runAfter?: Date;
    maxAttempts?: number;
  },
): Promise<void> {
  await tx
    .insert(tasks)
    .values({
      kind: input.kind,
      dedupeKey: input.dedupeKey ?? null,
      payloadJson: input.payload,
      runAfter: input.runAfter ?? sql`now()`,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
    .onConflictDoNothing({ target: tasks.dedupeKey });
}
