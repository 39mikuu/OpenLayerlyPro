import { type APIResponse, expect, type Page, test } from "@playwright/test";
import sharp from "sharp";

import { closeDb, getDb } from "../src/db";
import { files, postFiles, posts, siteSettings } from "../src/db/schema";

const ADMIN_EMAIL = "security-e2e@example.com";
const ADMIN_PASSWORD = "security-e2e-password";

async function okData<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { ok: boolean; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

function nonceFromPolicy(policy: string): string {
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  return nonce!;
}

function policyDirective(policy: string, name: string): string {
  const directive = policy
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name} `));
  expect(directive).toBeTruthy();
  return directive!;
}

async function expectDocumentNonce(page: Page, expectedNonce: string) {
  const scripts = await page.locator("script").evaluateAll((items) =>
    items.map((item) => ({
      src: (item as HTMLScriptElement).src,
      nonce: (item as HTMLScriptElement).nonce,
    })),
  );
  expect(scripts.length).toBeGreaterThan(0);
  expect(
    scripts.every((script) => script.nonce === expectedNonce),
    JSON.stringify(scripts, null, 2),
  ).toBe(true);
}

test("nonce CSP protects public, admin, login, integration, media, and download flows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserImage = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 20, g: 120, b: 220 },
    },
  })
    .png()
    .toBuffer();
  const browserVideo = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext("2d")!;
      const stream = canvas.captureStream(10);
      const mimeType = "video/webm;codecs=vp8";
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();
      for (let frame = 0; frame < 5; frame += 1) {
        context.fillStyle = frame % 2 === 0 ? "#1478dc" : "#dc7814";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer()));
    }),
  );
  const cspErrors: string[] = [];
  const reportOnlyCspErrors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (!/content security policy|refused to (?:load|execute|connect)/i.test(text)) return;
    if (/report[- ]only/i.test(text)) reportOnlyCspErrors.push(text);
    else cspErrors.push(text);
  });

  let integrationScriptRequested = false;
  let integrationConnectRequested = false;
  let integrationPixelRequested = false;
  const plausiblePageviews: string[] = [];
  let turnstileScriptRequested = false;
  let s3ImageRequested = false;
  let s3VideoRequested = false;
  let videoFrameRequested = false;
  page.on("request", (request) => {
    const resourceUrl = new URL(request.url());
    if (resourceUrl.origin !== "https://artist-media.objects.example") return;
    if (resourceUrl.pathname.includes("security-image")) s3ImageRequested = true;
    if (resourceUrl.pathname.includes("security-video")) s3VideoRequested = true;
  });

  await page.route("https://scripts.example/**", async (route) => {
    integrationScriptRequested = true;
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        window.__olpIntegrationLoaded = true;
        fetch("https://events.example/collect", { method: "POST", body: "{}" });
        const image = new Image();
        image.src = "https://pixel.example/pixel.png";
      `,
    });
  });
  await page.route("https://events.example/**", async (route) => {
    integrationConnectRequested = true;
    await route.fulfill({
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "",
    });
  });
  await page.route("https://plausible-script.example/**", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        (function () {
          var queued = (window.plausible && window.plausible.q) || [];
          var endpoint = document.currentScript.dataset.api;
          function plausible(name, payload) {
            if (name === "pageview") {
              fetch(endpoint, {
                method: "POST",
                body: JSON.stringify({ name: name, url: payload.url })
              });
            }
          }
          window.plausible = plausible;
          queued.forEach(function (args) { plausible.apply(null, args); });
        })();
      `,
    });
  });
  await page.route("https://plausible-events.example/api/event", async (route) => {
    const payload = route.request().postDataJSON() as { name: string; url: string };
    expect(payload.name).toBe("pageview");
    plausiblePageviews.push(payload.url);
    await route.fulfill({
      status: 202,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "",
    });
  });
  await page.route("https://pixel.example/**", async (route) => {
    integrationPixelRequested = true;
    await route.fulfill({ contentType: "image/png", body: browserImage });
  });
  await page.route("https://challenges.cloudflare.com/**", async (route) => {
    turnstileScriptRequested = true;
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        window.turnstile = {
          render(element) { element.dataset.turnstileRendered = "true"; return "widget"; },
          reset() {},
          remove() {}
        };
      `,
    });
  });
  await page.route(/^https:\/\/artist-media\.objects\.example\//, async (route) => {
    const objectUrl = new URL(route.request().url());
    if (objectUrl.pathname.includes("security-image")) {
      await route.fulfill({ contentType: "image/png", body: browserImage });
      return;
    }
    if (objectUrl.pathname.includes("security-video")) {
      const contentDisposition = objectUrl.searchParams.get("response-content-disposition");
      await route.fulfill({
        status: 206,
        contentType: "video/webm",
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(browserVideo.length),
          "Content-Range": `bytes 0-${browserVideo.length - 1}/${browserVideo.length}`,
          ...(contentDisposition ? { "Content-Disposition": contentDisposition } : {}),
        },
        body: browserVideo,
      });
      return;
    }
    await route.abort();
  });
  await page.route("https://www.youtube-nocookie.com/**", async (route) => {
    videoFrameRequested = true;
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>video frame smoke</title>",
    });
  });
  await okData(
    await page.request.post("/api/admin/setup", {
      data: {
        siteName: "Security E2E",
        artistName: "Security Artist",
        artistBio: "Browser validation",
        adminEmail: ADMIN_EMAIL,
        adminPassword: ADMIN_PASSWORD,
      },
    }),
  );
  const loginApiResponse = await page.request.post("/api/auth/admin/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  await okData(loginApiResponse);
  const setCookie = loginApiResponse.headers()["set-cookie"];
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toMatch(/SameSite=Lax/i);
  const sessionCookie = setCookie.match(/^([^=]+)=([^;]+)/);
  expect(sessionCookie).not.toBeNull();
  // The production cookie is correctly Secure. This isolated smoke server uses
  // plain loopback HTTP, so install the same token without Secure for transport.
  await page.context().addCookies([
    {
      name: sessionCookie![1],
      value: sessionCookie![2],
      url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const updateAdminSite = async (data: Record<string, unknown>) => {
    const current = await okData<{ cspRevision: string }>(
      await page.request.get("/api/admin/site"),
    );
    return okData<{ cspRevision: string }>(
      await page.request.put("/api/admin/site", {
        data: { ...data, cspRevision: current.cspRevision },
      }),
    );
  };
  const uploaded = await okData<{ id: string }>(
    await page.request.post("/api/admin/files/upload", {
      multipart: {
        purpose: "artist_avatar",
        file: {
          name: "avatar.png",
          mimeType: "image/png",
          buffer: browserImage,
        },
      },
    }),
  );
  const localVideo = await okData<{ id: string }>(
    await page.request.post("/api/admin/files/upload/stream", {
      headers: {
        "Content-Type": "video/webm",
        "x-file-name": encodeURIComponent("local-security-video.webm"),
        "x-file-purpose": "content_attachment",
      },
      data: browserVideo,
    }),
  );
  const turnstileView = await okData<{ enabled: boolean; siteKey?: string }>(
    await page.request.put("/api/admin/config/turnstile", {
      data: {
        enabled: true,
        siteKey: "e2e-site-key",
        secretKey: "e2e-secret-key",
      },
    }),
  );
  expect(turnstileView).toMatchObject({ enabled: true, siteKey: "e2e-site-key" });
  await updateAdminSite({
    artistAvatarFileId: uploaded.id,
    customFooterMarkup:
      '<p class="filing">Security footer <a href="https://example.com">record</a></p>',
    siteVerification: [{ provider: "google", content: "e2e-verification-token" }],
    publicIntegrations: [
      {
        id: "browser-smoke",
        provider: "custom",
        placement: "body",
        src: "https://scripts.example/browser-smoke.js",
        defer: true,
        data: { site: "security-e2e" },
        csp: {
          script: [],
          connect: ["https://events.example"],
          image: ["https://pixel.example"],
          frame: [],
        },
      },
      {
        id: "plausible-browser-smoke",
        provider: "plausible",
        domain: "artist.example",
        scriptUrl: "https://plausible-script.example/script.manual.js",
        apiOrigin: "https://plausible-events.example",
      },
    ],
  });

  const mediaResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/files/${uploaded.id}/download`) && response.status() === 200,
  );
  const homeResponse = await page.goto("/");
  expect(homeResponse).not.toBeNull();
  const homePolicy = homeResponse!.headers()["content-security-policy"];
  expect(homePolicy).toBeTruthy();
  expect(homeResponse!.headers()["content-security-policy-report-only"]).toBeUndefined();
  expect(policyDirective(homePolicy, "script-src")).not.toContain("'unsafe-inline'");
  expect(policyDirective(homePolicy, "script-src")).not.toContain("'unsafe-eval'");
  expect(policyDirective(homePolicy, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
  expect(homePolicy).toContain("https://scripts.example");
  expect(homePolicy).toContain("https://events.example");
  expect(homePolicy).toContain("https://pixel.example");
  expect(homePolicy).toContain("https://challenges.cloudflare.com");
  const homeNonce = nonceFromPolicy(homePolicy);
  await expectDocumentNonce(page, homeNonce);

  await expect(page.locator('meta[name="google-site-verification"]')).toHaveAttribute(
    "content",
    "e2e-verification-token",
  );
  await expect(page.getByText("Security footer")).toBeVisible();
  await expect.poll(() => integrationScriptRequested).toBe(true);
  await expect.poll(() => integrationConnectRequested).toBe(true);
  await expect.poll(() => integrationPixelRequested).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__olpIntegrationLoaded)).toBe(true);
  await expect
    .poll(() => plausiblePageviews)
    .toEqual([`${process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001"}/`]);
  await page.evaluate(() => history.pushState({}, "", "/me?private=secret"));
  await page.evaluate(() => history.replaceState({}, "", "/checkout/order?token=private"));
  await page.evaluate(() => history.pushState({}, "", "/posts?cursor=next"));
  await page.evaluate(() => history.replaceState({}, "", "/posts?cursor=next"));
  await page.evaluate(() => history.pushState({}, "", "/admin"));
  await page.evaluate(() => history.back());
  await expect
    .poll(() => plausiblePageviews)
    .toEqual([
      `${process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001"}/`,
      `${process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001"}/posts?cursor=next`,
      `${process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001"}/posts?cursor=next`,
    ]);
  expect(plausiblePageviews.join("\n")).not.toMatch(/private|checkout|admin|token/);
  await page.evaluate(() => history.replaceState({}, "", "/"));
  const memberBoundaryResponsePromise = page.waitForResponse(
    (response) =>
      response.request().resourceType() === "document" &&
      new URL(response.url()).pathname === "/me",
  );
  await page.getByRole("link", { name: "Me", exact: true }).first().click();
  const memberBoundaryResponse = await memberBoundaryResponsePromise;
  expect(memberBoundaryResponse!.headers()["content-security-policy"]).not.toContain(
    "https://scripts.example",
  );
  await expect(page.locator('script[src^="https://scripts.example"]')).toHaveCount(0);
  const publicScopeResponsePromise = page.waitForResponse(
    (response) =>
      response.request().resourceType() === "document" &&
      new URL(response.url()).pathname === "/posts",
  );
  await page.locator('a[href="/posts"]').last().click();
  const publicScopeResponse = await publicScopeResponsePromise;
  expect(publicScopeResponse!.headers()["content-security-policy"]).toContain(
    "https://scripts.example",
  );
  await expect(page.locator('script[src^="https://scripts.example"]')).toHaveCount(1);
  await page.goto("/tiers");
  const checkoutResponsePromise = page.waitForResponse(
    (response) =>
      response.request().resourceType() === "document" &&
      new URL(response.url()).pathname.startsWith("/checkout/"),
  );
  await page.locator('a[href^="/checkout/"]').first().click();
  const checkoutResponse = await checkoutResponsePromise;
  expect(checkoutResponse!.headers()["content-security-policy"]).not.toContain(
    "https://scripts.example",
  );
  await expect(page.locator('script[src^="https://scripts.example"]')).toHaveCount(0);
  await page.goto("/");

  const mediaResponse = await mediaResponsePromise;
  expect(mediaResponse.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(mediaResponse.headers()["content-security-policy"]).toContain("sandbox");
  expect(mediaResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(mediaResponse.headers()["cache-control"]).toBe("private, no-store");

  await okData(
    await page.request.put("/api/admin/config/storage", {
      data: {
        driver: "s3",
        endpoint: "https://objects.example",
        region: "auto",
        bucket: "artist-media",
        accessKeyId: "e2e-access-key",
        secretAccessKey: "e2e-secret-key",
        forcePathStyle: false,
      },
    }),
  );
  const db = getDb();
  const [s3Image] = await db
    .insert(files)
    .values({
      storageDriver: "s3",
      bucket: "artist-media",
      objectKey: "security-image.png",
      originalName: "security-image.png",
      mimeType: "image/png",
      sizeBytes: browserImage.length,
      purpose: "artist_avatar",
    })
    .returning({ id: files.id });
  const [publicPost] = await db
    .insert(posts)
    .values({
      title: "S3 CSP video",
      slug: "s3-csp-video",
      body: "@video: https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      visibility: "public",
      status: "published",
      publishedAt: new Date(),
    })
    .returning({ id: posts.id });
  const [s3Video] = await db
    .insert(files)
    .values({
      storageDriver: "s3",
      bucket: "artist-media",
      objectKey: "security-video.webm",
      originalName: "security-video.webm",
      mimeType: "video/webm",
      sizeBytes: browserVideo.length,
      purpose: "content_attachment",
    })
    .returning({ id: files.id });
  await db.insert(postFiles).values([
    { postId: publicPost.id, fileId: localVideo.id, kind: "attachment", sortOrder: 0 },
    { postId: publicPost.id, fileId: s3Video.id, kind: "attachment", sortOrder: 1 },
  ]);
  await db.insert(siteSettings).values({
    key: "custom_footer_html",
    valueJson: "<script>window.__legacyFooterExecuted = true</script>",
  });
  await closeDb();
  await updateAdminSite({ artistAvatarFileId: s3Image.id });

  const secondHomeResponse = await page.reload();
  expect(secondHomeResponse!.headers()["content-security-policy"]).toBeUndefined();
  const secondHomePolicy = secondHomeResponse!.headers()["content-security-policy-report-only"];
  expect(nonceFromPolicy(secondHomePolicy)).not.toBe(homeNonce);
  expect(secondHomePolicy).toContain("img-src");
  expect(secondHomePolicy).toContain("media-src");
  expect(secondHomePolicy).toContain("https://artist-media.objects.example");
  await expect.poll(() => page.evaluate(() => window.__legacyFooterExecuted)).toBe(true);
  await expect(page.getByText("Security footer")).toBeVisible();
  const imageRedirect = await page.request.get(`/api/files/${s3Image.id}/download`, {
    maxRedirects: 0,
  });
  expect(imageRedirect.status()).toBe(302);
  const signedImageUrl = imageRedirect.headers().location;
  expect(new URL(signedImageUrl).origin).toBe("https://artist-media.objects.example");
  await page.evaluate((sourceUrl) => {
    const image = document.createElement("img");
    image.id = "s3-signed-image";
    image.alt = "S3 CSP smoke";
    image.src = sourceUrl;
    document.body.append(image);
  }, signedImageUrl);
  await expect.poll(() => s3ImageRequested).toBe(true);
  await expect
    .poll(() =>
      page
        .locator("#s3-signed-image")
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  const legacyLoginResponse = await page.goto("/login");
  expect(legacyLoginResponse!.headers()["content-security-policy"]).toBeUndefined();
  expect(legacyLoginResponse!.headers()["content-security-policy-report-only"]).toBeTruthy();
  await expect.poll(() => page.evaluate(() => window.__legacyFooterExecuted)).toBe(true);
  await expect(page.getByText("Security footer")).toBeVisible();
  await expect(page.locator('script[src^="https://scripts.example"]')).toHaveCount(0);

  s3ImageRequested = false;
  const adminResponse = await page.goto("/admin/site");
  expect(adminResponse!.headers()["content-security-policy"]).toBeUndefined();
  const adminPolicy = adminResponse!.headers()["content-security-policy-report-only"];
  expect(adminPolicy).toBeTruthy();
  expect(adminPolicy).not.toContain("https://scripts.example");
  expect(adminPolicy).toContain("https://artist-media.objects.example");
  await expect(page.locator('script[src^="https://scripts.example"]')).toHaveCount(0);
  await expect.poll(() => s3ImageRequested).toBe(true);
  await expectDocumentNonce(page, nonceFromPolicy(adminPolicy));
  await expect(page.getByText("Public page security and integrations")).toBeVisible();
  await expect(page.getByText(/Executable legacy code is still active/)).toBeVisible();
  const stalePage = await page.context().newPage();
  await stalePage.goto("/admin/site");
  const currentSaveResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/site") &&
      response.request().method() === "PUT" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await currentSaveResponsePromise;
  const staleSaveResponsePromise = stalePage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/site") &&
      response.request().method() === "PUT" &&
      response.status() === 409,
  );
  await stalePage.getByRole("button", { name: "Save settings" }).click();
  const staleSaveResponse = await staleSaveResponsePromise;
  await expect(staleSaveResponse.json()).resolves.toMatchObject({
    ok: false,
    code: "publicSecurityRevisionConflict",
  });
  await expect(stalePage.getByText(/changed in another tab|其他标签页|別のタブ/i)).toBeVisible();
  await stalePage.close();
  const clearResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/site") &&
      response.request().method() === "PUT" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Clear legacy source" }).click();
  await clearResponsePromise;
  await expect(page.getByText(/Executable legacy code is still active/)).toHaveCount(0);

  const enforcedHomeResponse = await page.goto("/");
  expect(enforcedHomeResponse!.headers()["content-security-policy"]).toBeTruthy();
  expect(enforcedHomeResponse!.headers()["content-security-policy-report-only"]).toBeUndefined();
  expect(await page.evaluate(() => window.__legacyFooterExecuted)).toBeUndefined();

  await updateAdminSite({ customFooterMarkup: "" });
  const safeLegacyDb = getDb();
  await safeLegacyDb.insert(siteSettings).values({
    key: "custom_footer_html",
    valueJson: '<p class="legacy-filing">Legacy filing record</p>',
  });
  await closeDb();
  await page.goto("/admin/site");
  const migrateResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/site") &&
      response.request().method() === "PUT" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Migrate safe markup" }).click();
  await migrateResponsePromise;
  await expect(page.getByRole("button", { name: "Migrate safe markup" })).toHaveCount(0);
  const saveResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/site") &&
      response.request().method() === "PUT" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await saveResponsePromise;
  const publicBoundaryResponsePromise = page.waitForResponse(
    (response) =>
      response.request().resourceType() === "document" && new URL(response.url()).pathname === "/",
  );
  await page.getByRole("link", { name: "View site" }).click();
  const publicBoundaryResponse = await publicBoundaryResponsePromise;
  expect(publicBoundaryResponse!.headers()["content-security-policy"]).toContain(
    "https://scripts.example",
  );
  await expect(page.locator('script[src^="https://scripts.example"]')).toHaveCount(1);
  await expect(page.getByText("Legacy filing record")).toBeVisible();

  await page.context().clearCookies();
  const publicResponse = await page.goto("/posts/s3-csp-video");
  expect(publicResponse!.headers()["content-security-policy"]).toContain(
    "https://artist-media.objects.example",
  );
  await expect(page.locator('iframe[src^="https://www.youtube-nocookie.com/embed/"]')).toHaveCount(
    1,
  );
  await expect.poll(() => videoFrameRequested).toBe(true);
  const localVideoPlayer = page.locator(`video[src*="/api/files/${localVideo.id}/download"]`);
  await expect(localVideoPlayer).toHaveCount(1);
  await expect
    .poll(() => localVideoPlayer.evaluate((video) => (video as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);

  const videoRedirect = await page.request.get(`/api/files/${s3Video.id}/download?mode=inline`, {
    maxRedirects: 0,
  });
  expect(videoRedirect.status()).toBe(302);
  const signedVideoUrl = videoRedirect.headers().location;
  expect(new URL(signedVideoUrl).origin).toBe("https://artist-media.objects.example");
  const s3VideoPlayer = page.locator(`video[src*="/api/files/${s3Video.id}/download"]`);
  await expect(s3VideoPlayer).toHaveCount(1);
  await expect(s3VideoPlayer).toHaveAttribute(
    "src",
    `/api/files/${s3Video.id}/download?mode=inline`,
  );
  await s3VideoPlayer.evaluate((video, sourceUrl) => {
    const player = video as HTMLVideoElement;
    const freshPlayer = player.cloneNode(true) as HTMLVideoElement;
    freshPlayer.id = "s3-signed-video";
    freshPlayer.removeAttribute("src");
    player.replaceWith(freshPlayer);
    freshPlayer.src = sourceUrl;
    freshPlayer.load();
  }, signedVideoUrl);
  const signedVideoPlayer = page.locator("#s3-signed-video");
  await expect.poll(() => s3VideoRequested).toBe(true);
  await expect
    .poll(() => signedVideoPlayer.evaluate((video) => (video as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);

  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.request().resourceType() === "document" &&
      new URL(response.url()).pathname === "/login",
  );
  await page.locator('a[href="/login"]').first().click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse!.headers()["content-security-policy"]).toContain(
    "https://challenges.cloudflare.com",
  );
  expect(loginResponse!.headers()["content-security-policy"]).not.toContain(
    "https://scripts.example",
  );
  expect(await loginResponse!.text()).toContain("e2e-site-key");
  await expect.poll(() => turnstileScriptRequested).toBe(true);
  await expect(page.locator("[data-turnstile-rendered=true]")).toHaveCount(1);
  await expectDocumentNonce(
    page,
    nonceFromPolicy(loginResponse!.headers()["content-security-policy"]),
  );
  await page.goto("/posts/s3-csp-video");

  const localDownloadResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/files/${localVideo.id}/download`) &&
      response.status() === 200 &&
      response.request().resourceType() === "document",
  );
  const localDownloadEventPromise = page.waitForEvent("download");
  await page.locator(`a[href="/download/${localVideo.id}"]`).click();
  const localDownloadResponse = await localDownloadResponsePromise;
  const localDownloadEvent = await localDownloadEventPromise;
  expect(localDownloadResponse.headers()["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  expect(localDownloadResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(localDownloadResponse.headers()["cache-control"]).toBe("private, no-store");
  await localDownloadEvent.cancel();

  s3VideoRequested = false;
  const s3DownloadRedirectPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/files/${s3Video.id}/download`) &&
      response.status() === 302 &&
      response.request().resourceType() === "document",
  );
  await page.locator(`a[href="/download/${s3Video.id}"]`).click();
  const s3DownloadRedirect = await s3DownloadRedirectPromise;
  expect(s3DownloadRedirect.headers()["x-content-type-options"]).toBe("nosniff");
  expect(s3DownloadRedirect.headers()["cache-control"]).toBe("private, no-store");
  expect(new URL(s3DownloadRedirect.headers().location).origin).toBe(
    "https://artist-media.objects.example",
  );
  await expect.poll(() => s3VideoRequested).toBe(true);

  const downloadResponse = await page.request.get(`/download/${uploaded.id}`);
  expect(downloadResponse.status()).toBe(200);
  expect(downloadResponse.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(downloadResponse.headers()["content-security-policy"]).toContain("sandbox");
  expect(downloadResponse.headers()["x-content-type-options"]).toBe("nosniff");

  for (const path of ["/missing.js", "/fileXsvg-page", "/_next/imageish"]) {
    const assetLookingNotFound = await page.goto(path);
    expect(assetLookingNotFound!.status()).toBe(404);
    expect(assetLookingNotFound!.headers()["content-security-policy"]).toBeTruthy();
    expect(assetLookingNotFound!.headers()["x-frame-options"]).toBe("DENY");
  }

  expect(cspErrors).toEqual([]);
  expect(reportOnlyCspErrors.length).toBeGreaterThan(0);
  expect(
    reportOnlyCspErrors.every((message) =>
      /inline script|script-src.*unsafe-inline/i.test(message),
    ),
    reportOnlyCspErrors.join("\n"),
  ).toBe(true);
});

declare global {
  interface Window {
    __legacyFooterExecuted?: boolean;
    __olpIntegrationLoaded?: boolean;
  }
}
