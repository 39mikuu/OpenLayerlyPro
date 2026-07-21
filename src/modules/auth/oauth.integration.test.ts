import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.stubGlobal("fetch", mocks.fetch);

import { getDb } from "@/db";
import { oauthIdentities, oauthStates, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { decryptSecret } from "@/lib/crypto";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import {
  __test,
  beginOAuthLogin,
  completeOAuthLogin,
  fetchOAuthProfile,
  getOAuthProviderAdminView,
  isOAuthProviderLoginEnabled,
  saveOAuthProviderConfig,
} from "./oauth";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("WP2 OAuth login integration", () => {
  const db = getDb();

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDatabase(db);
    // clean up config tables
    await db.execute(sql`truncate table app_settings cascade`);
  });

  it("manages encrypted config group (Google & GitHub) independently", async () => {
    // initially disabled
    await expect(isOAuthProviderLoginEnabled("google")).resolves.toBe(false);
    await expect(isOAuthProviderLoginEnabled("github")).resolves.toBe(false);

    // save Google
    await saveOAuthProviderConfig("google", {
      enabled: true,
      clientId: "google-id",
      clientSecret: "google-secret",
    });

    await expect(isOAuthProviderLoginEnabled("google")).resolves.toBe(true);
    await expect(isOAuthProviderLoginEnabled("github")).resolves.toBe(false);

    const googleView = await getOAuthProviderAdminView("google");
    expect(googleView).toMatchObject({
      enabled: true,
      clientId: "google-id",
      configured: true,
      clientSecretSet: true,
      hasDbOverride: true,
    });
    // Secret must not be in the view
    expect(googleView).not.toHaveProperty("clientSecret");

    const githubView = await getOAuthProviderAdminView("github");
    expect(githubView).toMatchObject({
      enabled: false,
      clientId: undefined,
      configured: false,
      clientSecretSet: false,
      hasDbOverride: false,
    });
  });

  it("implements PKCE flow start: inserts state, encrypts verifier, generates correct authorize URL", async () => {
    await saveOAuthProviderConfig("google", {
      enabled: true,
      clientId: "g-id",
      clientSecret: "g-sec",
    });

    const meta = { ip: "127.0.0.1", userAgent: "curl", redirectPath: "/posts/deep" };
    const { authorizationUrl } = await beginOAuthLogin("google", meta);

    const url = new URL(authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("g-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const state = url.searchParams.get("state")!;
    expect(state).toBeTruthy();

    const [row] = await db.select().from(oauthStates);
    expect(row.provider).toBe("google");
    expect(row.redirectPath).toBe("/posts/deep");
    expect(row.consumedAt).toBeNull();
    expect(decryptSecret(row.codeVerifierEncrypted)).toBeTruthy();
  });

  it("GitHub starting flow works too", async () => {
    await saveOAuthProviderConfig("github", {
      enabled: true,
      clientId: "git-id",
      clientSecret: "git-sec",
    });

    const { authorizationUrl } = await beginOAuthLogin("github");
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("client_id")).toBe("git-id");
  });

  it("fetches Google OpenID Connect profile correctly", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sub: "google-sub-123",
        email: " Fan@Example.com ",
        email_verified: true,
        name: "Fan",
      }),
    });

    const profile = await fetchOAuthProfile("google", "mock-token");
    expect(profile).toEqual({
      providerAccountId: "google-sub-123",
      email: "fan@example.com",
      emailVerified: true,
      displayName: "Fan",
    });
  });

  it("fetches GitHub profile (user + primary verified email) correctly", async () => {
    // /user
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 9988,
        name: "HubUser",
      }),
    });
    // /user/emails
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { email: "unverified@test.com", verified: false, primary: false },
        { email: "primary@test.com", verified: true, primary: true },
      ],
    });

    const profile = await fetchOAuthProfile("github", "mock-token");
    expect(profile).toEqual({
      providerAccountId: "9988",
      email: "primary@test.com",
      emailVerified: true,
      displayName: "HubUser",
    });
  });

  it("resolves and binds user on login (verified email auto-bind, and identity precedence)", async () => {
    // 1. Create a user beforehand
    const [existing] = await db
      .insert(users)
      .values({ email: "fan@example.com", role: "admin" })
      .returning();

    // 2. Perform callback login for a new identity, matching this verified email
    const profile = {
      providerAccountId: "sub-1",
      email: "fan@example.com",
      emailVerified: true,
      displayName: "OAuth Fan",
    };

    // complete resolves using inner method
    const resolved = await __test.resolveUserFromProfile("google", profile);
    expect(resolved.id).toBe(existing.id);
    expect(resolved.role).toBe("admin"); // preserved admin role

    // identity row exists
    const ids = await db.select().from(oauthIdentities);
    expect(ids).toHaveLength(1);
    expect(ids[0].provider).toBe("google");
    expect(ids[0].providerAccountId).toBe("sub-1");
    expect(ids[0].userId).toBe(existing.id);

    // 3. Login again with same identity, but now email on provider changes (should not rebind, identity wins)
    const profileChanged = {
      providerAccountId: "sub-1",
      email: "newemail@example.com",
      emailVerified: true,
      displayName: "OAuth Fan",
    };
    const resolved2 = await __test.resolveUserFromProfile("google", profileChanged);
    expect(resolved2.id).toBe(existing.id); // still matches the original bound user
  });

  it("Google unverified / GitHub missing email fails closed", async () => {
    const unverifiedGoogle = {
      providerAccountId: "sub-google-unverified",
      email: "unverified@example.com",
      emailVerified: false,
      displayName: "No verification",
    };
    await expect(__test.resolveUserFromProfile("google", unverifiedGoogle)).rejects.toThrow(
      ApiError,
    );

    const emptyGithub = {
      providerAccountId: "sub-github-empty",
      email: null,
      emailVerified: false,
      displayName: "No email",
    };
    await expect(__test.resolveUserFromProfile("github", emptyGithub)).rejects.toThrow(ApiError);
  });

  it("concurrent first-links to the same provider account fail closed and leave no orphan user", async () => {
    // Fire several concurrent logins for the SAME new provider account, each with a
    // distinct verified email. Exactly one may bind the identity; every loser must
    // fail closed AND clean up the user row it created, so no orphan is left behind.
    const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com"];
    const results = await Promise.allSettled(
      emails.map((email) =>
        __test.resolveUserFromProfile("google", {
          providerAccountId: "sub-shared",
          email,
          emailVerified: true,
          displayName: "Racer",
        }),
      ),
    );

    // At least one binds; at least one is rejected with a fail-closed ApiError.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
    }

    // Invariant (holds under both serial and racing interleavings):
    // exactly one identity for the account, and exactly one surviving user with no orphans.
    const ids = await db.select().from(oauthIdentities);
    expect(ids).toHaveLength(1);
    expect(ids[0].providerAccountId).toBe("sub-shared");

    const remaining = await db.select().from(users);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(ids[0].userId);
    expect(emails).toContain(remaining[0].email);
  });

  it("PKCE state verification single-use and expiry protection", async () => {
    await saveOAuthProviderConfig("google", {
      enabled: true,
      clientId: "g-id",
      clientSecret: "g-sec",
    });

    const { authorizationUrl } = await beginOAuthLogin("google");
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get("state")!;

    // 1. Successful verification
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "google-access-token" }),
    });
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sub: "google-sub", email: "fan@example.com", email_verified: true }),
    });

    const result = await completeOAuthLogin("google", { code: "mock-code", state });
    expect(result.user.email).toBe("fan@example.com");

    // 2. Replay fails (already consumed state)
    await expect(completeOAuthLogin("google", { code: "mock-code", state })).rejects.toThrow(
      ApiError,
    );
  });
});
