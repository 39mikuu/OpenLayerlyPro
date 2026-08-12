import { z } from "zod";

import { ApiError } from "@/lib/api";

export const expectedRevisionSchema = z.number().int().nonnegative();
export const configClearSchema = z.object({ revision: expectedRevisionSchema });

export function requireExpectedRevision(actualRevision: number, expectedRevision: number): void {
  if (actualRevision !== expectedRevision) throw new ApiError(409, "configConflict");
}

export function requireWrittenRevision<T extends { revision: number }>(
  view: T,
  writtenRevision: number,
): T {
  if (view.revision !== writtenRevision) throw new ApiError(409, "configConflict");
  return view;
}
