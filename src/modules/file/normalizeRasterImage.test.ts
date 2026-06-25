import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ IMAGE_MAX_FRAMES: 300, IMAGE_MAX_TOTAL_PIXELS: 300_000_000 }),
}));

import { normalizeRasterImage, UnsupportedRasterImageError } from "./normalizeRasterImage";

async function animatedInput(format: "gif" | "webp"): Promise<Buffer> {
  const width = 2;
  const pageHeight = 2;
  const frameA = Buffer.alloc(width * pageHeight * 4);
  const frameB = Buffer.alloc(width * pageHeight * 4);
  for (let i = 0; i < frameA.length; i += 4) {
    frameA.set([255, 0, 0, 255], i);
    frameB.set([0, 0, 255, 255], i);
  }
  const image = sharp(Buffer.concat([frameA, frameB]), {
    raw: { width, height: pageHeight * 2, channels: 4, pageHeight },
  });
  return format === "gif"
    ? image.gif({ loop: 0, delay: [20, 20] }).toBuffer()
    : image.webp({ loop: 0, delay: [20, 20] }).toBuffer();
}

describe("normalizeRasterImage", () => {
  it.each([
    ["jpeg", "image/jpeg", "jpg"],
    ["png", "image/png", "png"],
    ["webp", "image/webp", "webp"],
  ] as const)(
    "re-encodes %s using authoritative output metadata",
    async (format, mimeType, ext) => {
      let input = sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } });
      if (format === "jpeg") input = input.jpeg();
      if (format === "png") input = input.png();
      if (format === "webp") input = input.webp();
      const bytes = await input.toBuffer();

      const result = await normalizeRasterImage(bytes, "content_image");

      expect(result.mimeType).toBe(mimeType);
      expect(result.ext).toBe(ext);
      expect(result.width).toBe(3);
      expect(result.height).toBe(2);
      expect(result.sizeBytes).toBe(result.outputBuffer.length);
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it("rejects SVG rather than trusting a client-provided image extension or MIME", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    await expect(normalizeRasterImage(svg, "content_image")).rejects.toBeInstanceOf(
      UnsupportedRasterImageError,
    );
  });

  it("strips a polyglot trailer by re-encoding only decoded pixels", async () => {
    const clean = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const polyglot = Buffer.concat([clean, Buffer.from("<script>alert(1)</script>")]);

    const result = await normalizeRasterImage(polyglot, "content_image");

    expect(result.outputBuffer.includes(Buffer.from("<script>"))).toBe(false);
    expect(result.outputBuffer.equals(polyglot)).toBe(false);
    expect((await sharp(result.outputBuffer).metadata()).format).toBe("jpeg");
  });

  it("physically rotates EXIF orientation before stripping metadata", async () => {
    const oriented = await sharp({
      create: { width: 2, height: 3, channels: 3, background: "green" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await normalizeRasterImage(oriented, "content_image");
    const output = await sharp(result.outputBuffer).metadata();

    expect([result.width, result.height]).toEqual([3, 2]);
    expect(output.orientation).toBeUndefined();
  });

  it("preserves animated webp only for content_image and flattens it elsewhere", async () => {
    const input = await animatedInput("webp");

    const kept = await normalizeRasterImage(input, "content_image");
    const flattened = await normalizeRasterImage(input, "payment_proof");

    expect((await sharp(kept.outputBuffer, { animated: true }).metadata()).pages).toBe(2);
    expect((await sharp(flattened.outputBuffer, { animated: true }).metadata()).pages ?? 1).toBe(1);
  });

  it("converts animated GIF to animated webp only for content_image", async () => {
    const input = await animatedInput("gif");
    const result = await normalizeRasterImage(input, "content_image");

    expect(result.mimeType).toBe("image/webp");
    expect((await sharp(result.outputBuffer, { animated: true }).metadata()).pages).toBe(2);
    await expect(normalizeRasterImage(input, "payment_proof")).rejects.toBeInstanceOf(
      UnsupportedRasterImageError,
    );
  });
});
