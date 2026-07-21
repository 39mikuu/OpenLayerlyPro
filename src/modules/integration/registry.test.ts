import { access } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnv } from "@/lib/env";
import {
  getSmtpAdminView,
  getStorageAdminView,
  getStorageConfig,
  getStripeAdminView,
  getTranslationAdminView,
  getTurnstileAdminView,
} from "@/modules/config";
import { sendTestEmail } from "@/modules/mail";
import { testStripeConnection } from "@/modules/payment/providers";
import { getSetting } from "@/modules/site";
import { testS3Connection } from "@/modules/storage";

vi.mock("fs/promises", () => ({
  access: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(),
}));

vi.mock("@/modules/config", () => ({
  getSmtpAdminView: vi.fn(),
  getStorageAdminView: vi.fn(),
  getStorageConfig: vi.fn(),
  getStripeAdminView: vi.fn(),
  getTranslationAdminView: vi.fn(),
  getTurnstileAdminView: vi.fn(),
}));

vi.mock("@/modules/mail", () => ({
  sendTestEmail: vi.fn(),
}));

vi.mock("@/modules/payment/providers", () => ({
  testStripeConnection: vi.fn(),
}));

vi.mock("@/modules/site", () => ({
  getSetting: vi.fn(),
}));

vi.mock("@/modules/storage", () => ({
  testS3Connection: vi.fn(),
}));

const mockedAccess = vi.mocked(access);
const mockedGetEnv = vi.mocked(getEnv);
const mockedGetSmtpAdminView = vi.mocked(getSmtpAdminView);
const mockedGetStorageAdminView = vi.mocked(getStorageAdminView);
const mockedGetStorageConfig = vi.mocked(getStorageConfig);
const mockedGetStripeAdminView = vi.mocked(getStripeAdminView);
const mockedGetTranslationAdminView = vi.mocked(getTranslationAdminView);
const mockedGetTurnstileAdminView = vi.mocked(getTurnstileAdminView);
const mockedSendTestEmail = vi.mocked(sendTestEmail);
const mockedGetSetting = vi.mocked(getSetting);
const mockedTestStripeConnection = vi.mocked(testStripeConnection);
const mockedTestS3Connection = vi.mocked(testS3Connection);

function mockEnv(tunnelToken?: string) {
  mockedGetEnv.mockReturnValue({
    UPLOAD_DIR: "/tmp/uploads",
    CLOUDFLARE_TUNNEL_TOKEN: tunnelToken,
    SECURITY_CSP_MODE: "auto",
  } as ReturnType<typeof getEnv>);
}

function mockPublicIntegrations(value: unknown = null) {
  mockedGetSetting.mockResolvedValue(value);
}

function mockSmtp(input?: { configured?: boolean; hasDbOverride?: boolean }) {
  const configured = input?.configured ?? true;
  mockedGetSmtpAdminView.mockResolvedValue({
    host: configured ? "smtp.example.com" : undefined,
    port: 587,
    secure: false,
    from: configured ? "site@example.com" : undefined,
    passwordSet: false,
    hasDbOverride: input?.hasDbOverride ?? false,
    envDefaults: {
      port: 587,
      secure: false,
      passwordSet: false,
    },
  });
}

function mockStorage(input?: {
  driver?: "local" | "s3";
  s3Configured?: boolean;
  hasDbOverride?: boolean;
}) {
  mockedGetStorageAdminView.mockResolvedValue({
    driver: input?.driver ?? "local",
    region: "auto",
    forcePathStyle: true,
    s3Configured: input?.s3Configured ?? false,
    accessKeyIdSet: false,
    secretAccessKeySet: false,
    hasDbOverride: input?.hasDbOverride ?? false,
    envDefaults: {
      driver: "local",
      region: "auto",
      forcePathStyle: true,
      accessKeyIdSet: false,
      secretAccessKeySet: false,
    },
  });
}

function mockTurnstile(input?: {
  enabled?: boolean;
  configured?: boolean;
  hasDbOverride?: boolean;
}) {
  const configured = input?.configured ?? true;
  mockedGetTurnstileAdminView.mockResolvedValue({
    enabled: input?.enabled ?? true,
    siteKey: configured ? "site-key" : undefined,
    secretKeySet: configured,
    hasDbOverride: input?.hasDbOverride ?? false,
    envDefaults: {
      enabled: false,
      secretKeySet: false,
    },
  });
}

function mockStripe(input?: { enabled?: boolean; configured?: boolean; hasDbOverride?: boolean }) {
  const configured = input?.configured ?? true;
  mockedGetStripeAdminView.mockResolvedValue({
    enabled: input?.enabled ?? true,
    publishableKey: undefined,
    currency: "usd",
    configured,
    secretKeySet: configured,
    webhookSecretSet: configured,
    hasDbOverride: input?.hasDbOverride ?? true,
  });
}

function mockTranslation(input?: {
  enabled?: boolean;
  configured?: boolean;
  hasDbOverride?: boolean;
}) {
  mockedGetTranslationAdminView.mockResolvedValue({
    enabled: input?.enabled ?? false,
    provider: "openai-compatible",
    model: input?.configured ? "translation-model" : undefined,
    endpoint: input?.configured ? "https://api.example.com/v1" : undefined,
    monthlyCharLimit: undefined,
    directPublishEnabled: false,
    showMachineTranslationLabel: false,
    configured: input?.configured ?? false,
    apiKeySet: input?.configured ?? false,
    hasDbOverride: input?.hasDbOverride ?? false,
  });
}

describe("integration registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv();
    mockSmtp();
    mockStorage();
    mockStripe();
    mockTurnstile();
    mockTranslation();
    mockPublicIntegrations();
    mockedGetStorageConfig.mockResolvedValue({ s3Configured: false } as never);
    mockedAccess.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns nine integrations in stable order", async () => {
    const { getIntegrationStatuses } = await import("./registry");
    const statuses = await getIntegrationStatuses();

    expect(statuses.map((status) => status.id)).toEqual([
      "smtp",
      "storage",
      "stripe",
      "turnstile",
      "translation",
      "umami",
      "oauth_google",
      "oauth_github",
      "tunnel",
    ]);
  });

  it("derives SMTP configured, enabled and source from one admin view", async () => {
    mockSmtp({ configured: true, hasDbOverride: true });
    const { getIntegrationStatuses } = await import("./registry");
    const [smtp] = await getIntegrationStatuses();

    expect(smtp).toEqual({
      id: "smtp",
      kind: "service",
      configured: true,
      enabled: true,
      source: "database",
    });
    expect(mockedGetSmtpAdminView).toHaveBeenCalledTimes(1);
  });

  it("reports unconfigured SMTP as disabled", async () => {
    mockSmtp({ configured: false });
    const { getIntegrationStatuses } = await import("./registry");
    const [smtp] = await getIntegrationStatuses();

    expect(smtp).toMatchObject({
      configured: false,
      enabled: false,
      source: "environment",
    });
  });

  it("checks local upload directory writable and unwritable states", async () => {
    const { getIntegrationStatuses } = await import("./registry");
    let storage = (await getIntegrationStatuses())[1];
    expect(storage).toMatchObject({
      configured: true,
      enabled: true,
      source: "environment",
      driver: "local",
    });

    mockedAccess.mockRejectedValueOnce(new Error("EACCES"));
    storage = (await getIntegrationStatuses())[1];
    expect(storage).toMatchObject({
      configured: false,
      enabled: true,
      driver: "local",
    });
  });

  it("reports complete and incomplete S3 configurations", async () => {
    mockStorage({ driver: "s3", s3Configured: true, hasDbOverride: true });
    const { getIntegrationStatuses } = await import("./registry");
    let storage = (await getIntegrationStatuses())[1];
    expect(storage).toMatchObject({
      configured: true,
      enabled: true,
      source: "database",
      driver: "s3",
    });

    mockStorage({ driver: "s3", s3Configured: false });
    storage = (await getIntegrationStatuses())[1];
    expect(storage).toMatchObject({
      configured: false,
      enabled: true,
      driver: "s3",
    });
  });

  it("keeps Turnstile configured separate from enabled", async () => {
    mockTurnstile({ enabled: true, configured: true });
    const { getIntegrationStatuses } = await import("./registry");
    let turnstile = (await getIntegrationStatuses())[3];
    expect(turnstile).toMatchObject({
      configured: true,
      enabled: true,
      source: "environment",
    });

    mockTurnstile({ enabled: false, configured: true, hasDbOverride: true });
    turnstile = (await getIntegrationStatuses())[3];
    expect(turnstile).toMatchObject({
      configured: true,
      enabled: false,
      source: "database",
    });

    mockTurnstile({ enabled: true, configured: false });
    turnstile = (await getIntegrationStatuses())[3];
    expect(turnstile).toMatchObject({
      configured: false,
      enabled: true,
    });
  });

  it("reports Tunnel token presence as environment deployment status", async () => {
    mockEnv(" tunnel-token ");
    const { getIntegrationStatuses } = await import("./registry");
    let tunnel = (await getIntegrationStatuses())[8];
    expect(tunnel).toEqual({
      id: "tunnel",
      kind: "deployment",
      configured: true,
      enabled: true,
      source: "environment",
    });

    mockEnv(" ");
    tunnel = (await getIntegrationStatuses())[8];
    expect(tunnel).toEqual({
      id: "tunnel",
      kind: "deployment",
      configured: false,
      enabled: false,
      source: "none",
    });
  });

  it("reports translation configured and enabled separately", async () => {
    mockTranslation({ enabled: false, configured: true, hasDbOverride: true });
    const { getIntegrationStatuses } = await import("./registry");
    let translation = (await getIntegrationStatuses())[4];
    expect(translation).toEqual({
      id: "translation",
      kind: "service",
      configured: true,
      enabled: false,
      source: "database",
    });

    mockTranslation({ enabled: true, configured: false, hasDbOverride: true });
    translation = (await getIntegrationStatuses())[4];
    expect(translation).toMatchObject({
      configured: false,
      enabled: true,
      source: "database",
    });
  });

  it("reports missing Umami public integrations as unconfigured", async () => {
    mockPublicIntegrations([]);
    const { getIntegrationStatuses } = await import("./registry");
    const umami = (await getIntegrationStatuses())[5];

    expect(umami).toEqual({
      id: "umami",
      kind: "service",
      configured: false,
      enabled: false,
      source: "none",
    });
  });

  it("reports valid Umami public integrations from database settings", async () => {
    mockPublicIntegrations([
      {
        id: "disabled-analytics",
        provider: "umami",
        enabled: false,
        websiteId: "11111111-1111-4111-8111-111111111111",
      },
      {
        id: "enabled-analytics",
        provider: "umami",
        websiteId: "22222222-2222-4222-8222-222222222222",
      },
    ]);
    const { getIntegrationStatuses } = await import("./registry");
    let umami = (await getIntegrationStatuses())[5];
    expect(umami).toEqual({
      id: "umami",
      kind: "service",
      configured: true,
      enabled: true,
      source: "database",
    });

    mockPublicIntegrations([
      {
        id: "disabled-analytics",
        provider: "umami",
        enabled: false,
        websiteId: "11111111-1111-4111-8111-111111111111",
      },
    ]);
    umami = (await getIntegrationStatuses())[5];
    expect(umami).toEqual({
      id: "umami",
      kind: "service",
      configured: true,
      enabled: false,
      source: "database",
    });
  });

  it("reports invalid stored Umami public integrations as a database read error", async () => {
    mockPublicIntegrations([{ id: "analytics", provider: "umami" }]);
    const { getIntegrationStatuses } = await import("./registry");
    const umami = (await getIntegrationStatuses())[5];

    expect(umami).toEqual({
      id: "umami",
      kind: "service",
      configured: false,
      enabled: false,
      source: "database",
      error: true,
    });
  });

  it("isolates one integration failure and keeps remaining statuses", async () => {
    mockedGetTurnstileAdminView.mockRejectedValue(new Error("decrypt failed"));
    const { getIntegrationStatuses } = await import("./registry");
    const statuses = await getIntegrationStatuses();

    expect(statuses).toHaveLength(9);
    expect(statuses[0].error).toBeUndefined();
    expect(statuses[3]).toEqual({
      id: "turnstile",
      kind: "service",
      configured: false,
      enabled: false,
      source: "none",
      error: true,
    });
    expect(statuses[8].id).toBe("tunnel");
  });

  it("reports Stripe configuration separately from its enabled state and tests connectivity", async () => {
    mockStripe({ enabled: false, configured: true, hasDbOverride: true });
    const { getIntegrationStatuses, integrations } = await import("./registry");
    const stripe = (await getIntegrationStatuses())[2];
    expect(stripe).toEqual({
      id: "stripe",
      kind: "service",
      configured: true,
      enabled: false,
      source: "database",
    });

    await integrations.find((integration) => integration.id === "stripe")!.test!({
      adminEmail: "admin@example.test",
      locale: "en",
    });
    expect(mockedTestStripeConnection).toHaveBeenCalledOnce();
  });

  it("exposes smtp, storage, and Stripe as testable", async () => {
    const { testableIntegrationIds, integrations } = await import("./registry");
    expect(testableIntegrationIds).toEqual(["smtp", "storage", "stripe"]);
    expect(
      integrations.find((integration) => integration.id === "turnstile")?.test,
    ).toBeUndefined();
    expect(integrations.find((integration) => integration.id === "tunnel")?.test).toBeUndefined();
    expect(
      integrations.find((integration) => integration.id === "translation")?.test,
    ).toBeUndefined();
    expect(integrations.find((integration) => integration.id === "umami")?.test).toBeUndefined();
  });

  it("SMTP test sends a test email to the admin address", async () => {
    const { integrations } = await import("./registry");
    const smtpTest = integrations.find((integration) => integration.id === "smtp")?.test;
    expect(smtpTest).toBeDefined();
    await smtpTest?.({ adminEmail: "admin@example.com", locale: "en" });
    expect(mockedSendTestEmail).toHaveBeenCalledWith("admin@example.com", "en");
  });

  it("storage test runs the S3 connection check", async () => {
    const { integrations } = await import("./registry");
    const storageTest = integrations.find((integration) => integration.id === "storage")?.test;
    expect(storageTest).toBeDefined();
    await storageTest?.({ adminEmail: "admin@example.com", locale: "zh" });
    expect(mockedTestS3Connection).toHaveBeenCalledTimes(1);
  });

  it("propagates connection test failures", async () => {
    mockedTestS3Connection.mockRejectedValueOnce(new Error("S3/R2 连接测试失败"));
    const { integrations } = await import("./registry");
    const storageTest = integrations.find((integration) => integration.id === "storage")?.test;
    await expect(storageTest?.({ adminEmail: "admin@example.com", locale: "zh" })).rejects.toThrow(
      "S3/R2 连接测试失败",
    );
  });
});
