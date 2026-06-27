export type ArchiveIntegrityMismatch = {
  missingFromManifest: string[];
  extraInManifest: string[];
};

export class ArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveIntegrityError";
  }
}

export function parseChecksumManifestPaths(content: string): string[] {
  const paths: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^[0-9a-f]{64}\s+(\*?)(.+)$/i);
    if (!match) {
      throw new ArchiveIntegrityError(`invalid checksum manifest line: ${trimmed}`);
    }
    paths.push(match[2]!);
  }

  return paths.sort((left, right) => left.localeCompare(right));
}

export function comparePayloadAndManifest(
  payloadFiles: readonly string[],
  manifestPaths: readonly string[],
): ArchiveIntegrityMismatch {
  const payloadSet = new Set(payloadFiles);
  const manifestSet = new Set(manifestPaths);

  const missingFromManifest = [...payloadSet]
    .filter((path) => !manifestSet.has(path))
    .sort((left, right) => left.localeCompare(right));
  const extraInManifest = [...manifestSet]
    .filter((path) => !payloadSet.has(path))
    .sort((left, right) => left.localeCompare(right));

  return { missingFromManifest, extraInManifest };
}

export function validateChecksumBijection(
  payloadFiles: readonly string[],
  manifestContent: string,
): void {
  const manifestPaths = parseChecksumManifestPaths(manifestContent);
  const mismatch = comparePayloadAndManifest(payloadFiles, manifestPaths);

  if (mismatch.missingFromManifest.length > 0 || mismatch.extraInManifest.length > 0) {
    const details: string[] = [];
    if (mismatch.missingFromManifest.length > 0) {
      details.push(`missing from manifest: ${mismatch.missingFromManifest.join(", ")}`);
    }
    if (mismatch.extraInManifest.length > 0) {
      details.push(`extra in manifest: ${mismatch.extraInManifest.join(", ")}`);
    }
    throw new ArchiveIntegrityError(
      `checksum manifest does not match archive payload file set (${details.join("; ")})`,
    );
  }
}
