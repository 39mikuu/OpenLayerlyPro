import type { Locale } from "@/modules/i18n";

export type IntegrationId = "smtp" | "storage" | "turnstile" | "translation" | "tunnel";

export type IntegrationKind = "service" | "deployment";

export type IntegrationSource = "database" | "environment" | "none";

export type IntegrationStatus = {
  id: IntegrationId;
  kind: IntegrationKind;
  /**
   * Whether the required configuration is complete and usable.
   * This is independent from enabled: Turnstile may be configured but disabled.
   */
  configured: boolean;
  /**
   * Whether the integration is currently active.
   * SMTP and Tunnel are enabled when configured; Storage is always enabled.
   */
  enabled: boolean;
  source: IntegrationSource;
  driver?: "local" | "s3";
  /** Status collection failed, rather than the integration being unconfigured. */
  error?: boolean;
};

export type IntegrationTestContext = {
  /** Email of the admin triggering the test; SMTP sends the test message here. */
  adminEmail: string;
  locale: Locale;
};

export type Integration = {
  id: IntegrationId;
  kind: IntegrationKind;
  getStatus(): Promise<IntegrationStatus>;
  /**
   * Optional connectivity test. Resolves on success; throws (ApiError/Error with a
   * message) on failure. Absent means the integration is not testable.
   */
  test?(ctx: IntegrationTestContext): Promise<void>;
};
