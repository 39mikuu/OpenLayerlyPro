import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  readJsonWithLimit: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readJsonWithLimit: mocks.readJsonWithLimit,
  };
});

vi.mock("@/modules/auth/session", () => ({
  requireAdmin: mocks.requireAdmin,
}));

import { PUT as putSmtp } from "./smtp/route";
import { PUT as putStorage } from "./storage/route";
import { PUT as putStripe } from "./stripe/route";
import { PUT as putTranslation } from "./translation/route";
import { PUT as putTurnstile } from "./turnstile/route";
import { PUT as putUpload } from "./upload/route";

const routes = [
  ["smtp", putSmtp],
  ["storage", putStorage],
  ["stripe", putStripe],
  ["translation", putTranslation],
  ["turnstile", putTurnstile],
  ["upload", putUpload],
] as const;

function oversizedRequest(route: string): NextRequest {
  const body = JSON.stringify({ value: "x".repeat(1_000_000) });
  return new Request(`http://localhost/api/admin/config/${route}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  }) as unknown as NextRequest;
}

describe("admin config authentication order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockRejectedValue(new ApiError(401, "authRequired"));
  });

  it.each(routes)(
    "rejects an unauthenticated oversized %s request before business body parsing",
    async (route, put) => {
      const response = await put(oversizedRequest(route));

      expect(response.status).toBe(401);
      expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
      expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    },
  );
});
