import type { TaskExecutionContext } from "./ownership";

export function ownedTaskExecutionContext(): TaskExecutionContext {
  return {
    signal: new AbortController().signal,
    ownershipLost: () => false,
    assertOwnership: async () => undefined,
  };
}
