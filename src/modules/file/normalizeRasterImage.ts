import { createHash } from "crypto";
import sharp, { type Metadata } from "sharp";

import { getEnv } from "@/lib/env";

export type RasterImagePurpose =
  | "artist_avatar"
  | "payment_qr"
  | "payment_proof"
  | "content_image"
  | "cover"
  | "thumbnail";

export class UnsupportedRasterImageError extends Error {
  constructor(readonly detectedFormat: string | undefined) {
    super(`Unsupported raster image format: ${detectedFormat ?? "unknown"}`);
    this.name = "UnsupportedRasterImageError";
  }
}

export class UnsafeRasterImageError extends Error {
  constructor(readonly reason: "invalid" | "frames" | "totalPixels" | "singleFramePixels") {
    super(`Unsafe raster image: ${reason}`);
    this.name = "UnsafeRasterImageError";
  }
}

export type NormalizedRasterImage = {
  outputBuffer: Buffer;
  format: "jpeg" | "png" | "webp";
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  animated: boolean;
  inputFormat: "jpeg" | "png" | "webp" | "gif";
};

const SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp", "gif"]);
const LIMIT_INPUT_PIXELS = 100_000_000;

function outputInfo(format: "jpeg" | "png" | "webp") {
  if (format === "jpeg") return { mimeType: "image/jpeg" as const, ext: "jpg" as const };
  if (format === "png") return { mimeType: "image/png" as const, ext: "png" as const };
  return { mimeType: "image/webp" as const, ext: "webp" as const };
}

export async function normalizeRasterImage(
  input: Buffer,
  purpose: RasterImagePurpose,
): Promise<NormalizedRasterImage> {
  const prefix = input
    .subarray(0, Math.min(input.length, 4096))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (
    prefix.startsWith("<svg") ||
    prefix.startsWith("<?xml") ||
    prefix.startsWith("<!doctype html") ||
    prefix.startsWith("<html")
  ) {
    throw new UnsupportedRasterImageError(prefix.includes("svg") ? "svg" : "html");
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input, {
      failOn: "error",
      limitInputPixels: LIMIT_INPUT_PIXELS,
    }).metadata();
  } catch {
    throw new UnsafeRasterImageError("invalid");
  }

  const detected = metadata.format;
  if (!detected || !SUPPORTED_FORMATS.has(detected)) {
    throw new UnsupportedRasterImageError(detected);
  }
  const inputFormat = detected as NormalizedRasterImage["inputFormat"];
  if (inputFormat === "gif" && purpose !== "content_image") {
    throw new UnsupportedRasterImageError(inputFormat);
  }

  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new UnsafeRasterImageError("invalid");
  const pages = metadata.pages ?? 1;
  const env = getEnv();
  if (pages > env.IMAGE_MAX_FRAMES) throw new UnsafeRasterImageError("frames");
  if (width * height > LIMIT_INPUT_PIXELS) throw new UnsafeRasterImageError("singleFramePixels");
  if (pages * width * height > env.IMAGE_MAX_TOTAL_PIXELS) {
    throw new UnsafeRasterImageError("totalPixels");
  }

  const preserveAnimation = purpose === "content_image" && pages > 1;
  const outputFormat: "jpeg" | "png" | "webp" = inputFormat === "gif" ? "webp" : inputFormat;

  let pipeline = sharp(input, {
    failOn: "error",
    limitInputPixels: LIMIT_INPUT_PIXELS,
    animated: preserveAnimation,
    pages: preserveAnimation ? -1 : 1,
  }).rotate();

  if (outputFormat === "jpeg") pipeline = pipeline.jpeg();
  else if (outputFormat === "png") pipeline = pipeline.png();
  else pipeline = pipeline.webp();

  let outputBuffer: Buffer;
  try {
    outputBuffer = await pipeline.toBuffer();
  } catch {
    throw new UnsafeRasterImageError("invalid");
  }

  let outputMetadata: Metadata;
  try {
    outputMetadata = await sharp(outputBuffer, {
      failOn: "error",
      limitInputPixels: LIMIT_INPUT_PIXELS,
      animated: preserveAnimation,
    }).metadata();
  } catch {
    throw new UnsafeRasterImageError("invalid");
  }
  if (!outputMetadata.width || !outputMetadata.height) throw new UnsafeRasterImageError("invalid");

  const { mimeType, ext } = outputInfo(outputFormat);
  return {
    outputBuffer,
    format: outputFormat,
    mimeType,
    ext,
    width: outputMetadata.width,
    height: outputMetadata.height,
    sizeBytes: outputBuffer.length,
    sha256: createHash("sha256").update(outputBuffer).digest("hex"),
    animated: preserveAnimation,
    inputFormat,
  };
}
