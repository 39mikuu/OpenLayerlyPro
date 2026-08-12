import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStoredGroupRevision: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/modules/config/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/config/store")>();
  return {
    ...original,
    getStoredGroupRevision: mocks.getStoredGroupRevision,
  };
});

import { PUT as githubPUT } from "@/app/api/admin/config/oauth/github/route";
import { PUT as googlePUT } from "@/app/api/admin/config/oauth/google/route";
import { PUT as smtpPUT } from "@/app/api/admin/config/smtp/route";
import { PUT as storagePUT } from "@/app/api/admin/config/storage/route";
import { PUT as stripePUT } from "@/app/api/admin/config/stripe/route";
import { PUT as translationPUT } from "@/app/api/admin/config/translation/route";
import { PUT as turnstilePUT } from "@/app/api/admin/config/turnstile/route";
import { PUT as uploadPUT } from "@/app/api/admin/config/upload/route";

type PutRoute = (request: NextRequest) => Promise<Response>;

const cases: Array<{ group: string; invalid: Record<string, unknown>; put: PutRoute }> = [
  { group: "smtp", invalid: { port: 0 }, put: smtpPUT },
  { group: "storage", invalid: { driver: "invalid" }, put: storagePUT },
  { group: "stripe", invalid: { currency: "xx" }, put: stripePUT },
  { group: "translation", invalid: { provider: "invalid" }, put: translationPUT },
  { group: "turnstile", invalid: { enabled: "invalid" }, put: turnstilePUT },
  { group: "upload", invalid: { maxUploadSizeMb: 0 }, put: uploadPUT },
  { group: "oauth_google", invalid: { enabled: "invalid" }, put: googlePUT },
  { group: "oauth_github", invalid: { enabled: "invalid" }, put: githubPUT },
];

function request(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost/api/admin/config/test", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("config PUT stale-write precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
  });

  it.each(cases)(
    "returns 409 before validating stale $group fields",
    async ({ group, invalid, put }) => {
      mocks.getStoredGroupRevision.mockResolvedValue(2);

      const response = await put(request({ revision: 1, ...invalid }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ ok: false, code: "configConflict" });
      expect(mocks.getStoredGroupRevision).toHaveBeenCalledWith(group);
    },
  );

  it.each(cases)(
    "still returns 400 for invalid current $group fields",
    async ({ invalid, put }) => {
      mocks.getStoredGroupRevision.mockResolvedValue(1);

      const response = await put(request({ revision: 1, ...invalid }));

      expect(response.status).toBe(400);
    },
  );
});
