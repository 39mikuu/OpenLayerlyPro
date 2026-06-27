import { describe, expect, it } from "vitest";

import {
  buildContentSecurityPolicy,
  exactHttpsOriginFromUrl,
  parseExactHttpsOrigin,
  resolveEffectiveCspMode,
  TURNSTILE_ORIGIN,
} from "./csp";

const sources = {
  script: ["https://analytics.example"],
  image: ["https://bucket.storage.example"],
  media: ["https://bucket.storage.example"],
  connect: ["https://events.example"],
  frame: ["https://frames.example"],
};

describe("CSP policy", () => {
  it("builds a production nonce policy without executable unsafe fallbacks", () => {
    const policy = buildContentSecurityPolicy({
      nonce: "dGVzdC1ub25jZS0xMjM0NTY=",
      production: true,
      upgradeInsecureRequests: true,
      sources,
    });

    expect(policy).toContain("'nonce-dGVzdC1ub25jZS0xMjM0NTY='");
    expect(policy.match(/script-src [^;]+/)?.[0]).not.toContain("'unsafe-inline'");
    expect(policy.match(/script-src [^;]+/)?.[0]).not.toContain("'unsafe-eval'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("script-src 'nonce-dGVzdC1ub25jZS0xMjM0NTY=' 'self'");
    expect(policy).toContain(TURNSTILE_ORIGIN);
    expect(policy).toContain("https://www.youtube-nocookie.com");
    expect(policy).toContain("img-src 'self' data: https://bucket.storage.example");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("allows unsafe-eval only for development tooling", () => {
    const policy = buildContentSecurityPolicy({
      nonce: "dGVzdC1ub25jZS0xMjM0NTY=",
      production: false,
      sources,
    });

    expect(policy).toContain("'unsafe-eval'");
    expect(policy.match(/script-src [^;]+/)?.[0]).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });

  it("rejects malformed or injectable nonces", () => {
    expect(() =>
      buildContentSecurityPolicy({
        nonce: "bad'; script-src *",
        production: true,
        sources,
      }),
    ).toThrow("Invalid CSP nonce");
  });
});

describe("exact HTTPS source validation", () => {
  it("normalizes exact origins and extracts origins from resource URLs", () => {
    expect(parseExactHttpsOrigin("https://Example.com:443")).toBe("https://example.com");
    expect(exactHttpsOriginFromUrl("https://cdn.example/path/script.js?v=1")).toBe(
      "https://cdn.example",
    );
  });

  it.each([
    "https:",
    "*",
    "https://*.example.com",
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com/?query=1",
    "https://example.com\nhttps://evil.example",
  ])("rejects non-exact source %s", (source) => {
    expect(parseExactHttpsOrigin(source)).toBeNull();
  });
});

describe("CSP rollout mode", () => {
  it("uses report-only only for auto mode with an executable legacy footer", () => {
    expect(resolveEffectiveCspMode("auto", true)).toBe("report-only");
    expect(resolveEffectiveCspMode("auto", false)).toBe("enforce");
    expect(resolveEffectiveCspMode("report-only", false)).toBe("report-only");
    expect(resolveEffectiveCspMode("enforce", true)).toBe("enforce");
  });
});
