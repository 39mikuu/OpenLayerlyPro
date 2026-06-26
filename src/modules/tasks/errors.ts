export type TaskFailureClassification =
  | "permanent"
  | "transient"
  | "needs_operator"
  | "lease_expired";

export class PermanentTaskError extends Error {
  readonly classification?: TaskFailureClassification;

  constructor(message: string, options?: { classification?: TaskFailureClassification }) {
    super(message);
    this.name = "PermanentTaskError";
    this.classification = options?.classification;
  }
}
