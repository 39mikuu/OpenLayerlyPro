export type MigrationIdentity = {
  tag: string;
  hash: string;
  createdAt: number;
};

export type MigrationHistoryEntry = {
  hash: string;
  createdAt: number;
};

export type SchemaCompatibilityResult = "compatible" | "newer_than_target" | "diverged" | "unknown";

export type SchemaCompatibilityReport = {
  result: SchemaCompatibilityResult;
  archiveLength: number;
  targetLength: number;
  firstMismatchIndex: number | null;
  reason?: string;
};

export type RestoreScanError = {
  fileId?: string;
  objectKey?: string;
  message: string;
};

export type PreScanReport = {
  scanned: number;
  quarantined: number;
  errors: RestoreScanError[];
};

export type NeutralizeReport = {
  deletedStorageDeleteTasks: number;
  providerEventsReset: number;
  providerDispatchTasksEnsured: number;
  emailRenewalRemindersReset: number;
  emailDeliveryNeutralized: number;
  otherTasksReset: number;
  subscriptionReconcileNormalized: boolean;
};

export type ConvergeDriverReport = {
  driver: "local" | "s3";
  bucket: string | null;
  referencedScanned: number;
  missingReferenced: number;
  newlyQuarantined: number;
  storageObjectsEnumerated: number;
  orphanObjects: number;
  orphanDeletesEnqueued: number;
  truncated: boolean;
  errors: RestoreScanError[];
};

export type ConvergeReport = {
  drivers: ConvergeDriverReport[];
  totalMissingReferenced: number;
  totalNewlyQuarantined: number;
  totalOrphanObjects: number;
  totalOrphanDeletesEnqueued: number;
  totalErrors: number;
  truncated: boolean;
};

export type SchemaCheckReport = {
  formatVersion: number;
  compatibility: SchemaCompatibilityReport;
  allowLegacyV1UnknownSchema: boolean;
  warnings: string[];
};
