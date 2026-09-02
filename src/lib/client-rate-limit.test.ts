import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetUnresolvedClientWarningForTests,
  assertProductionAuthClientIdentity,
} from "./client-rate-limit";

describe("production auth client identity", () => {
  beforeEach(() => {
    __resetUnresolvedClientWarningForTests();
    vi.restoreAllMocks();
  });

  it("fails closed instead of placing production auth traffic in a shared bucket", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      assertProductionAuthClientIdentity({ kind: "unresolved" }, "production", "admin login"),
    ).toThrow(expect.objectContaining({ status: 503, code: "trustedClientIpUnavailable" }));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Rejecting production"));
  });

  it("keeps emergency buckets available outside production and accepts resolved production IPs", () => {
    expect(() =>
      assertProductionAuthClientIdentity({ kind: "unresolved" }, "test", "admin login"),
    ).not.toThrow();
    expect(() =>
      assertProductionAuthClientIdentity(
        { kind: "ip", value: "198.51.100.10" },
        "production",
        "admin login",
      ),
    ).not.toThrow();
  });

  it("allows the explicit trusted-direct-network production exception with a warning", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      assertProductionAuthClientIdentity({ kind: "unresolved" }, "production", "admin login", {
        allowUnresolved: true,
      }),
    ).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("AUTH_ALLOW_UNRESOLVED_CLIENT_IP is enabled"),
    );
  });
});
