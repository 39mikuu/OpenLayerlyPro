import path from "path";

export function withAuthoritativeExtension(originalName: string, extension: string): string {
  const parsed = path.parse(originalName);
  const baseName = parsed.name || "file";
  return `${baseName}.${extension.replace(/^\./, "").toLowerCase()}`;
}

export function authoritativeExtensionFromObjectKey(objectKey: string): string | undefined {
  const extension = path.extname(objectKey).slice(1).toLowerCase();
  return extension || undefined;
}

const RASTER_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function authoritativeDownloadName(input: {
  originalName: string;
  objectKey: string;
  mimeType: string;
}): string {
  const extension =
    RASTER_EXTENSION_BY_MIME[input.mimeType.toLowerCase()] ??
    authoritativeExtensionFromObjectKey(input.objectKey);
  return extension ? withAuthoritativeExtension(input.originalName, extension) : input.originalName;
}
