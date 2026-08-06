import { performance } from "node:perf_hooks";

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertTurnstile: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("@/modules/i18n/server", () => ({ resolveLocale: mocks.resolveLocale }));
vi.mock("@/modules/security/turnstile", () => ({ assertTurnstile: mocks.assertTurnstile }));

import { getDb } from "@/db";
import { magicLinkRequests, tasks, users } from "@/db/schema";
import { __resetEnvForTests } from "@/lib/env";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import { POST } from "./route";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const SAMPLE_COUNT_PER_GROUP = 200;
const sourceIp = "198.51.100.184";
const savedEnv = {
  magicLinkIntakeEnabled: process.env.MAGIC_LINK_INTAKE_ENABLED,
  requestCodeIpRateMax: process.env.REQUEST_CODE_IP_RATE_MAX,
  trustedProxyHops: process.env.TRUSTED_PROXY_HOPS,
};

function restoreEnv(name: keyof typeof savedEnv, target: string) {
  const previous = savedEnv[name];
  if (previous === undefined) delete process.env[target];
  else process.env[target] = previous;
}

function request(email: string) {
  return new NextRequest("http://localhost/api/auth/magic-link/request", {
    method: "POST",
    body: JSON.stringify({ email }),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": sourceIp,
    },
  });
}

function percentile(samples: readonly number[], percentileValue: number) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue))]!;
}

describeWithDatabase("Magic Link public role-indistinguishability latency capacity", () => {
  const db = getDb();

  beforeEach(async () => {
    process.env.MAGIC_LINK_INTAKE_ENABLED = "true";
    // A single source issues three groups of 200 accepted requests. This is a
    // dedicated high-capacity test configuration, not the production default.
    process.env.REQUEST_CODE_IP_RATE_MAX = "750";
    process.env.TRUSTED_PROXY_HOPS = "1";
    __resetEnvForTests();
    __resetRateLimitForTests();
    mocks.resolveLocale.mockResolvedValue("en");
    mocks.assertTurnstile.mockResolvedValue(undefined);
    await resetDatabase(db);
  });

  afterAll(() => {
    restoreEnv("magicLinkIntakeEnabled", "MAGIC_LINK_INTAKE_ENABLED");
    restoreEnv("requestCodeIpRateMax", "REQUEST_CODE_IP_RATE_MAX");
    restoreEnv("trustedProxyHops", "TRUSTED_PROXY_HOPS");
    __resetEnvForTests();
    __resetRateLimitForTests();
  });

  it("collects 200 accepted samples for each role without response or limiter distinction", async () => {
    const emails = {
      admin: `latency-admin-${randomUUID()}@example.test`,
      member: `latency-member-${randomUUID()}@example.test`,
      unknown: `latency-unknown-${randomUUID()}@example.test`,
    };
    await db.insert(users).values([
      { email: emails.admin, role: "admin" },
      { email: emails.member, role: "member" },
    ]);

    const signatures = new Map<string, string[]>();
    const latencies = new Map<string, number[]>();
    for (const [role, email] of Object.entries(emails)) {
      const roleSignatures: string[] = [];
      const roleLatencies: number[] = [];
      for (let index = 0; index < SAMPLE_COUNT_PER_GROUP; index += 1) {
        const startedAt = performance.now();
        const response = await POST(request(email));
        const body = await response.text();
        roleLatencies.push(performance.now() - startedAt);
        roleSignatures.push(
          JSON.stringify({
            status: response.status,
            headers: [...response.headers.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
            body,
          }),
        );
      }
      signatures.set(role, roleSignatures);
      latencies.set(role, roleLatencies);
    }

    const expectedSignature = signatures.get("admin")?.[0];
    expect(expectedSignature).toBeDefined();
    for (const role of ["admin", "member", "unknown"]) {
      expect(signatures.get(role)).toHaveLength(SAMPLE_COUNT_PER_GROUP);
      expect(signatures.get(role)?.every((signature) => signature === expectedSignature)).toBe(
        true,
      );
      expect(latencies.get(role)).toHaveLength(SAMPLE_COUNT_PER_GROUP);
    }
    // The test report deliberately contains aggregate timing only—never an
    // email, role-bearing request record, or raw response payload.
    const report = Object.fromEntries(
      [...latencies.entries()].map(([role, samples]) => [
        role,
        {
          count: samples.length,
          p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
          p90Ms: Number(percentile(samples, 0.9).toFixed(2)),
          p99Ms: Number(percentile(samples, 0.99).toFixed(2)),
        },
      ]),
    );
    process.stdout.write(`Magic Link public-route latency report ${JSON.stringify(report)}\n`);

    await expect(db.select().from(magicLinkRequests)).resolves.toHaveLength(600);
    const intakeTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "auth.magic_link_request"));
    expect(intakeTasks).toHaveLength(600);
    expect(
      intakeTasks.every(
        (task) =>
          task.queueClass === "auth_intake" &&
          typeof task.payloadJson === "object" &&
          task.payloadJson !== null &&
          !Object.hasOwn(task.payloadJson, "email") &&
          !Object.hasOwn(task.payloadJson, "role"),
      ),
    ).toBe(true);
  }, 120_000);
});
