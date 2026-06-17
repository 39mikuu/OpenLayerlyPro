import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { getEnv, isProduction } from "@/lib/env";
import { getIntegrationStatuses } from "@/modules/integration";
import {
  getConfigEncryptionKey,
  isConfigEncryptionKeyConfigured,
} from "@/modules/security/config-key";

import { getReadiness } from "./readiness";

vi.mock("@/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/env", () => ({ getEnv: vi.fn(), isProduction: vi.fn() }));
vi.mock("@/modules/security/config-key", () => ({
  getConfigEncryptionKey: vi.fn(),
  isConfigEncryptionKeyConfigured: vi.fn(),
}));
vi.mock("@/modules/integration", () => ({ getIntegrationStatuses: vi.fn() }));

const mockedGetDb = vi.mocked(getDb);
const mockedGetEnv = vi.mocked(getEnv);
const mockedIsProduction = vi.mocked(isProduction);
const mockedGetConfigEncryptionKey = vi.mocked(getConfigEncryptionKey);
const mockedIsConfigEncryptionKeyConfigured = vi.mocked(isConfigEncryptionKeyConfigured);
const mockedGetIntegrationStatuses = vi.mocked(getIntegrationStatuses);

function mockDbOk(ok = true) {
  mockedGetDb.mockReturnValue({
    execute: ok
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error("db down")),
  } as unknown as ReturnType<typeof getDb>);
}

describe("getReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetEnv.mockReturnValue({} as ReturnType<typeof getEnv>);
    mockedIsProduction.mockReturnValue(false);
    mockedIsConfigEncryptionKeyConfigured.mockReturnValue(true);
    mockedGetConfigEncryptionKey.mockReturnValue("key");
    mockDbOk(true);
    mockedGetIntegrationStatuses.mockResolvedValue([
      { id: "smtp", kind: "service", configured: true, enabled: true, source: "database" },
      {
        id: "storage",
        kind: "service",
        configured: true,
        enabled: true,
        source: "environment",
        driver: "s3",
      },
      { id: "turnstile", kind: "service", configured: false, enabled: false, source: "none" },
      { id: "tunnel", kind: "deployment", configured: false, enabled: false, source: "none" },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is ready when core checks pass and omits integrations by default", async () => {
    const result = await getReadiness();
    expect(result.ready).toBe(true);
    expect(result.checks).toEqual({ database: true, config: true, encryptionKey: true });
    expect(result.integrations).toBeUndefined();
    expect(mockedGetIntegrationStatuses).not.toHaveBeenCalled();
  });

  it("includes coarse integration probes only when requested", async () => {
    const result = await getReadiness({ includeIntegrations: true });
    expect(result.integrations).toEqual([
      { id: "smtp", enabled: true, healthy: true },
      { id: "storage", enabled: true, healthy: true },
      { id: "turnstile", enabled: false, healthy: true },
      { id: "tunnel", enabled: false, healthy: true },
    ]);
  });

  it("marks enabled-but-unconfigured or errored integrations unhealthy, disabled as healthy", async () => {
    mockedGetIntegrationStatuses.mockResolvedValue([
      { id: "smtp", kind: "service", configured: false, enabled: true, source: "none" },
      {
        id: "storage",
        kind: "service",
        configured: false,
        enabled: false,
        source: "none",
        error: true,
      },
      { id: "turnstile", kind: "service", configured: true, enabled: false, source: "database" },
      { id: "tunnel", kind: "deployment", configured: true, enabled: true, source: "environment" },
    ]);
    const result = await getReadiness({ includeIntegrations: true });
    expect(result.integrations).toEqual([
      { id: "smtp", enabled: true, healthy: false },
      { id: "storage", enabled: false, healthy: false },
      { id: "turnstile", enabled: false, healthy: true },
      { id: "tunnel", enabled: true, healthy: true },
    ]);
  });

  it("never gates readiness on integration health", async () => {
    mockedGetIntegrationStatuses.mockResolvedValue([
      { id: "smtp", kind: "service", configured: false, enabled: true, source: "none" },
    ]);
    const result = await getReadiness({ includeIntegrations: true });
    expect(result.ready).toBe(true);
    expect(result.integrations?.[0]).toEqual({ id: "smtp", enabled: true, healthy: false });
  });

  it("is not ready when the database is unreachable", async () => {
    mockDbOk(false);
    const result = await getReadiness({ includeIntegrations: true });
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe(false);
  });

  it("stays ready and omits integrations if probing throws", async () => {
    mockedGetIntegrationStatuses.mockRejectedValue(new Error("probe failed"));
    const result = await getReadiness({ includeIntegrations: true });
    expect(result.ready).toBe(true);
    expect(result.integrations).toBeUndefined();
  });
});
