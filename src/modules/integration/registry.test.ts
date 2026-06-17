import { access } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnv } from "@/lib/env";
import {
  getSmtpAdminView,
  getStorageAdminView,
  getTranslationAdminView,
  getTurnstileAdminView,
} from "@/modules/config";
import { sendTestEmail } from "@/modules/mail";
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
  getTranslationAdminView: vi.fn(),
  getTurnstileAdminView: vi.fn(),
}));

vi.mock("@/modules/mail", () => ({
  sendTestEmail: vi.fn(),
}));

vi.mock("@/modules/storage", () => ({
  testS3Connection: vi.fn(),
}));

const mockedAccess = vi.mocked(access);
const mockedGetEnv = vi.mocked(getEnv);
const mockedGetSmtpAdminView = vi.mocked(getSmtpAdminView);
const mockedGetStorageAdminView = vi.mocked(getStorageAdminView);
const mockedGetTranslationAdminView = vi.mocked(getTranslationAdminView);
const mockedGetTurnstileAdminView = vi.mocked(getTurnstileAdminView);
const mockedSendTestEmail = vi.mocked(sendTestEmail);
const mockedTestS3Connection = vi.mocked(testS3Connection);

function mockEnv(tunnelToken?: string) {
  mockedGetEnv.mockReturnValue({
    UPLOAD_DIR: "/tmp/uploads",
    CLOUDFLARE_TUNNEL_TOKEN: tunnelToken,
  } as ReturnType<typeof getEnv>);
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
    mockTurnstile();
    mockTranslation();
    mockedAccess.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns five integrations in stable order", async () => {
    const { getIntegrationStatuses } = await import("./registry");
    const statuses = await getIntegrationStatuses();

    expect(statuses.map((status) => status.id)).toEqual([
      "smtp",
      "storage",
      "turnstile",
      "translation",
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
    let turnstile = (await getIntegrationStatuses())[2];
    expect(turnstile).toMatchObject({
      configured: true,
      enabled: true,
      source: "environment",
    });

    mockTurnstile({ enabled: false, configured: true, hasDbOverride: true });
    turnstile = (await getIntegrationStatuses())[2];
    expect(turnstile).toMatchObject({
      configured: true,
      enabled: false,
      source: "database",
    });

    mockTurnstile({ enabled: true, configured: false });
    turnstile = (await getIntegrationStatuses())[2];
    expect(turnstile).toMatchObject({
      configured: false,
      enabled: true,
    });
  });

  it("reports Tunnel token presence as environment deployment status", async () => {
    mockEnv(" tunnel-token ");
    const { getIntegrationStatuses } = await import("./registry");
    let tunnel = (await getIntegrationStatuses())[4];
    expect(tunnel).toEqual({
      id: "tunnel",
      kind: "deployment",
      configured: true,
      enabled: true,
      source: "environment",
    });

    mockEnv(" ");
    tunnel = (await getIntegrationStatuses())[4];
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
    let translation = (await getIntegrationStatuses())[3];
    expect(translation).toEqual({
      id: "translation",
      kind: "service",
      configured: true,
      enabled: false,
      source: "database",
    });

    mockTranslation({ enabled: true, configured: false, hasDbOverride: true });
    translation = (await getIntegrationStatuses())[3];
    expect(translation).toMatchObject({
      configured: false,
      enabled: true,
      source: "database",
    });
  });

  it("isolates one integration failure and keeps remaining statuses", async () => {
    mockedGetTurnstileAdminView.mockRejectedValue(new Error("decrypt failed"));
    const { getIntegrationStatuses } = await import("./registry");
    const statuses = await getIntegrationStatuses();

    expect(statuses).toHaveLength(5);
    expect(statuses[0].error).toBeUndefined();
    expect(statuses[2]).toEqual({
      id: "turnstile",
      kind: "service",
      configured: false,
      enabled: false,
      source: "none",
      error: true,
    });
    expect(statuses[4].id).toBe("tunnel");
  });

  it("exposes only smtp and storage as testable", async () => {
    const { testableIntegrationIds, integrations } = await import("./registry");
    expect(testableIntegrationIds).toEqual(["smtp", "storage"]);
    expect(
      integrations.find((integration) => integration.id === "turnstile")?.test,
    ).toBeUndefined();
    expect(integrations.find((integration) => integration.id === "tunnel")?.test).toBeUndefined();
    expect(
      integrations.find((integration) => integration.id === "translation")?.test,
    ).toBeUndefined();
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
