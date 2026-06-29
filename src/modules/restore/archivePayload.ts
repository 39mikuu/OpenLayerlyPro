export const ARCHIVE_CHECKSUM_MANIFEST = "checksums.sha256";

/** Regular-file payload members covered by v2 checksums (excludes only the root manifest). */
export function listArchivePayloadRelativePaths(entries: readonly string[]): string[] {
  return entries
    .map((entry) => entry.replace(/^\.\//, ""))
    .filter((entry) => entry.length > 0 && entry !== ARCHIVE_CHECKSUM_MANIFEST)
    .sort((left, right) => left.localeCompare(right));
}

export function findUnsupportedArchiveMembers(input: {
  hasSymlink: boolean;
  hasSpecialFile: boolean;
}): string[] {
  const unsupported: string[] = [];
  if (input.hasSymlink) unsupported.push("symlink");
  if (input.hasSpecialFile) unsupported.push("special file");
  return unsupported;
}
