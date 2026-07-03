import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, before, after) {
  const current = readFileSync(path, "utf8");
  const count = current.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one target, found ${count}`);
  writeFileSync(path, current.replace(before, after));
}

const contentPath = "src/modules/content/index.ts";
replaceOnce(
  contentPath,
  'import { type DbClient, getDb } from "@/db";',
  'import { type DbClient, getDb, type TxClient } from "@/db";',
);
replaceOnce(
  contentPath,
  'import { ApiError } from "@/lib/api";\nimport { isLocale, type Locale } from "@/modules/i18n";',
  'import { ApiError } from "@/lib/api";\nimport { lockFileReferences } from "@/modules/file/references";\nimport { isLocale, type Locale } from "@/modules/i18n";',
);
replaceOnce(
  contentPath,
  `export async function createPost(
  input: PostInput,
  taxonomy: PostTaxonomyInput = {},
): Promise<Post> {
  await assertValidTier(input);
  return getDb().transaction(async (tx) => {
    const [post] = await tx`,
  `export async function createPost(
  input: PostInput,
  taxonomy: PostTaxonomyInput = {},
): Promise<Post> {
  await assertValidTier(input);
  return getDb().transaction(async (tx) => {
    if (input.coverFileId) {
      await lockPostFileReference(tx, input.coverFileId, "cover");
    }
    const [post] = await tx`,
);
replaceOnce(
  contentPath,
  `    if (input.visibility === "member" || input.requiredTierId !== undefined) {
      await assertValidTier({
        visibility: input.visibility ?? existing.visibility,
        requiredTierId:
          input.requiredTierId !== undefined ? input.requiredTierId : existing.requiredTierId,
      });
    }

    const contentChanged =`,
  `    if (input.visibility === "member" || input.requiredTierId !== undefined) {
      await assertValidTier({
        visibility: input.visibility ?? existing.visibility,
        requiredTierId:
          input.requiredTierId !== undefined ? input.requiredTierId : existing.requiredTierId,
      });
    }
    if (input.coverFileId) {
      await lockPostFileReference(tx, input.coverFileId, "cover");
    }

    const contentChanged =`,
);
replaceOnce(
  contentPath,
  `export async function attachFileToPost(input: {
  postId: string;`,
  `async function lockPostFileReference(
  tx: TxClient,
  fileId: string,
  kind: PostFile["kind"],
): Promise<FileRecord> {
  const locked = await lockFileReferences(tx, [
    {
      fileId,
      invalid: (reason) =>
        reason === "missing"
          ? new ApiError(404, "fileNotFound")
          : new ApiError(410, "fileQuarantined"),
      validate: (record) => assertPostFilePurpose(kind, record.purpose),
    },
  ]);
  return locked.get(fileId)!;
}

export async function attachFileToPost(input: {
  postId: string;`,
);
replaceOnce(
  contentPath,
  `    const [file] = await tx
      .select({ purpose: files.purpose })
      .from(files)
      .where(eq(files.id, input.fileId))
      .limit(1);
    if (!file) throw new ApiError(404, "fileNotFound");
    assertPostFilePurpose(input.kind, file.purpose);

    const [link] = await tx`,
  `    await lockPostFileReference(tx, input.fileId, input.kind);

    const [link] = await tx`,
);

const inlinePath = "src/modules/content/inline-images.ts";
replaceOnce(
  inlinePath,
  'import type { DbClient } from "@/db";',
  'import type { DbClient, TxClient } from "@/db";',
);
replaceOnce(
  inlinePath,
  'import { ApiError } from "@/lib/api";\nimport { enqueueTask } from "@/modules/tasks";',
  'import { ApiError } from "@/lib/api";\nimport { lockFileReferences } from "@/modules/file/references";\nimport { enqueueTask } from "@/modules/tasks";',
);
replaceOnce(
  inlinePath,
  'export async function syncInlineImageLinks(tx: DbClient, postId: string): Promise<void> {',
  'export async function syncInlineImageLinks(tx: TxClient, postId: string): Promise<void> {',
);
replaceOnce(
  inlinePath,
  `  if (desired.length > 0) {
    const records = await tx
      .select({ id: files.id, purpose: files.purpose })
      .from(files)
      .where(inArray(files.id, desired));
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const fileId of desired) {
      const record = byId.get(fileId);
      if (!record) throw new ApiError(400, "inlineImageNotFound", { fileId });
      assertPostFilePurpose("inline", record.purpose);
    }
  }`,
  `  if (desired.length > 0) {
    await lockFileReferences(
      tx,
      desired.map((fileId) => ({
        fileId,
        invalid: (reason) =>
          reason === "missing"
            ? new ApiError(400, "inlineImageNotFound", { fileId })
            : new ApiError(410, "fileQuarantined"),
        validate: (record) => assertPostFilePurpose("inline", record.purpose),
      })),
    );
  }`,
);
