export class TaskOwnershipLostError extends Error {
  constructor() {
    super("Task lease ownership was lost");
    this.name = "TaskOwnershipLostError";
  }
}

export type TaskExecutionContext = {
  signal: AbortSignal;
  ownershipLost: () => boolean;
  assertOwnership: () => Promise<void>;
};
