import { afterEach, describe, expect, it } from "vitest";

import { __resetEnvForTests, getEnv } from "./env";

const watched = [
  "MAGIC_LINK_INTAKE_ENABLED",
  "MAGIC_LINK_DELIVERY_RESERVATION_SECONDS",
  "MAGIC_LINK_DELIVERY_MAX_TOTAL_SECONDS",
  "MAGIC_LINK_REQUEST_RETENTION_MINUTES",
  "REQUEST_CODE_RATE_WINDOW_MS",
] as const;
const original = new Map(watched.map((key) => [key, process.env[key]]));

function setEnv(input: Partial<Record<(typeof watched)[number], string | undefined>>) {
  for (const key of watched) {
    const value = input[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetEnvForTests();
}

describe("Magic Link protocol environment gates", () => {
  afterEach(() => {
    for (const key of watched) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetEnvForTests();
  });

  it("defaults intake to the phase-A compatibility gate and parses only explicit true", () => {
    setEnv({});
    expect(getEnv().MAGIC_LINK_INTAKE_ENABLED).toBe(false);

    setEnv({ MAGIC_LINK_INTAKE_ENABLED: "true" });
    expect(getEnv().MAGIC_LINK_INTAKE_ENABLED).toBe(true);

    setEnv({ MAGIC_LINK_INTAKE_ENABLED: "false" });
    expect(getEnv().MAGIC_LINK_INTAKE_ENABLED).toBe(false);

    setEnv({ MAGIC_LINK_INTAKE_ENABLED: "enabled" });
    expect(() => getEnv()).toThrow(/环境变量配置错误/);
  });

  it("rejects a reservation shorter than the hard SMTP deadline", () => {
    setEnv({
      MAGIC_LINK_DELIVERY_RESERVATION_SECONDS: "30",
      MAGIC_LINK_DELIVERY_MAX_TOTAL_SECONDS: "31",
    });
    expect(() => getEnv()).toThrow(/MAGIC_LINK_DELIVERY_RESERVATION_SECONDS/);
  });

  it("retains minted request rows for at least their full source-budget window", () => {
    setEnv({
      MAGIC_LINK_REQUEST_RETENTION_MINUTES: "1",
      REQUEST_CODE_RATE_WINDOW_MS: "120000",
    });
    expect(() => getEnv()).toThrow(/MAGIC_LINK_REQUEST_RETENTION_MINUTES/);
  });
});
