import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, before, after) {
  const current = readFileSync(path, "utf8");
  const count = current.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one target, found ${count}`);
  writeFileSync(path, current.replace(before, after));
}

function update(path, transform) {
  const current = readFileSync(path, "utf8");
  const next = transform(current);
  if (next === current) throw new Error(`${path}: transform made no change`);
  writeFileSync(path, next);
}

replaceOnce(
  "src/modules/file/references.ts",
  ` * caller's transaction. A file delete takes FOR UPDATE on the same row, so the
 * two operations serialize regardless of whether deletion or reference creation
 * arrives first.`,
  ` * caller's transaction. FOR SHARE conflicts with file UPDATE/DELETE while remaining
 * compatible with other reference creators. This makes quarantine, deletion, and
 * reference creation linearizable at the file row.`,
);
replaceOnce(
  "src/modules/file/references.ts",
  `.for("key share");`,
  `.for("share");`,
);

update("src/db/migrations/0020_file_reference_integrity.sql", (current) => {
  if (current.startsWith('LOCK TABLE "files"')) throw new Error("migration lock already present");
  const quarantinedPattern = /\n\s+OR f\.quarantined_at IS NOT NULL/g;
  const matches = current.match(quarantinedPattern) ?? [];
  if (matches.length !== 5) {
    throw new Error(`migration: expected 5 quarantine preflight clauses, found ${matches.length}`);
  }
  const withoutHistoricalQuarantineRejection = current.replace(quarantinedPattern, "");
  const withShareLock = withoutHistoricalQuarantineRejection.replace(
    "   FOR KEY SHARE;",
    "   FOR SHARE;",
  );
  if (withShareLock === withoutHistoricalQuarantineRejection) {
    throw new Error("migration: site-setting lock target missing");
  }
  return `LOCK TABLE "files", "payment_methods", "payment_requests", "post_files", "posts", "site_settings" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
${withShareLock}`;
});

const inlinePath = "src/modules/content/inline-images.ts";
replaceOnce(
  inlinePath,
  `/**
 * Reconciles body-owned inline links. Call only from a content write transaction
 * while the parent post row is locked FOR UPDATE.
 */`,
  `async function lockInlineImageIds(tx: TxClient, fileIds: readonly string[]): Promise<void> {
  if (fileIds.length === 0) return;
  await lockFileReferences(
    tx,
    fileIds.map((fileId) => ({
      fileId,
      invalid: (reason) =>
        reason === "missing"
          ? new ApiError(400, "inlineImageNotFound", { fileId })
          : new ApiError(410, "fileQuarantined"),
      validate: (record) => assertPostFilePurpose("inline", record.purpose),
    })),
  );
}

/** Locks prospective body references before the parent content row is locked. */
export async function lockInlineImageReferences(
  tx: TxClient,
  bodies: readonly (string | null | undefined)[],
): Promise<void> {
  const ids = new Set<string>();
  for (const body of bodies) {
    for (const fileId of extractInternalImageFileIds(body)) ids.add(fileId);
  }
  await lockInlineImageIds(tx, [...ids]);
}

/**
 * Reconciles body-owned inline links. Call only from a content write transaction
 * while the parent post row is locked FOR UPDATE.
 */`,
);
replaceOnce(
  inlinePath,
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
  `  await lockInlineImageIds(tx, desired);`,
);

const contentPath = "src/modules/content/index.ts";
replaceOnce(
  contentPath,
  `  enqueueOrphanCleanup,
  syncInlineImageLinks,`,
  `  enqueueOrphanCleanup,
  lockInlineImageReferences,
  syncInlineImageLinks,`,
);
replaceOnce(
  contentPath,
  `    if (input.coverFileId) {
      await lockPostFileReference(tx, input.coverFileId, "cover");
    }
    const [post] = await tx`,
  `    if (input.coverFileId) {
      await lockPostFileReference(tx, input.coverFileId, "cover");
    }
    await lockInlineImageReferences(tx, [input.body]);
    const [post] = await tx`,
);
replaceOnce(
  contentPath,
  `  return getDb().transaction(async (tx) => {
    const [existing] = await tx.select().from(posts).where(eq(posts.id, id)).limit(1).for("update");
    if (!existing) throw new ApiError(404, "postNotFound");
    if (existing.status !== "draft") throw new ApiError(409, "postNotEditable");

    if (input.visibility === "member" || input.requiredTierId !== undefined) {`,
  `  return getDb().transaction(async (tx) => {
    const [candidate] = await tx.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!candidate) throw new ApiError(404, "postNotFound");
    if (candidate.status !== "draft") throw new ApiError(409, "postNotEditable");
    if (input.coverFileId) {
      await lockPostFileReference(tx, input.coverFileId, "cover");
    }
    if (input.body !== undefined) {
      await lockInlineImageReferences(tx, [input.body]);
    }
    const [existing] = await tx.select().from(posts).where(eq(posts.id, id)).limit(1).for("update");
    if (!existing) throw new ApiError(404, "postNotFound");
    if (existing.status !== "draft") throw new ApiError(409, "postNotEditable");

    if (input.visibility === "member" || input.requiredTierId !== undefined) {`,
);
replaceOnce(
  contentPath,
  `    if (input.coverFileId) {
      await lockPostFileReference(tx, input.coverFileId, "cover");
    }

    const contentChanged =`,
  `
    const contentChanged =`,
);
replaceOnce(
  contentPath,
  `export async function savePublishedPostBody(id: string, body: string | null): Promise<Post> {
  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: posts.id, status: posts.status, body: posts.body })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1)
      .for("update");
    if (!existing) throw new ApiError(404, "postNotFound");
    if (existing.status !== "published") throw new ApiError(409, "postNotEditable");`,
  `export async function savePublishedPostBody(id: string, body: string | null): Promise<Post> {
  return getDb().transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: posts.id, status: posts.status })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);
    if (!candidate) throw new ApiError(404, "postNotFound");
    if (candidate.status !== "published") throw new ApiError(409, "postNotEditable");
    await lockInlineImageReferences(tx, [body]);
    const [existing] = await tx
      .select({ id: posts.id, status: posts.status, body: posts.body })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1)
      .for("update");
    if (!existing) throw new ApiError(404, "postNotFound");
    if (existing.status !== "published") throw new ApiError(409, "postNotEditable");`,
);
replaceOnce(
  contentPath,
  `  return dbc.transaction(async (tx) => {
    const post = await requireTranslationTarget(postId, locale, tx, {
      lock: true,
    });
    const title = requireTranslationTitle(input.title);`,
  `  return dbc.transaction(async (tx) => {
    await requireTranslationTarget(postId, locale, tx);
    await lockInlineImageReferences(tx, [input.body]);
    const post = await requireTranslationTarget(postId, locale, tx, {
      lock: true,
    });
    const title = requireTranslationTitle(input.title);`,
);
replaceOnce(
  contentPath,
  `  return getDb().transaction(async (tx) => {
    const [post] = await tx
      .select({ id: posts.id, status: posts.status })
      .from(posts)
      .where(eq(posts.id, input.postId))
      .limit(1)
      .for("update");
    if (!post) throw new ApiError(404, "postNotFound");
    if (post.status !== "draft") throw new ApiError(409, "postNotEditable");

    await lockPostFileReference(tx, input.fileId, input.kind);`,
  `  return getDb().transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: posts.id, status: posts.status })
      .from(posts)
      .where(eq(posts.id, input.postId))
      .limit(1);
    if (!candidate) throw new ApiError(404, "postNotFound");
    if (candidate.status !== "draft") throw new ApiError(409, "postNotEditable");
    await lockPostFileReference(tx, input.fileId, input.kind);
    const [post] = await tx
      .select({ id: posts.id, status: posts.status })
      .from(posts)
      .where(eq(posts.id, input.postId))
      .limit(1)
      .for("update");
    if (!post) throw new ApiError(404, "postNotFound");
    if (post.status !== "draft") throw new ApiError(409, "postNotEditable");`,
);

const paymentPath = "src/modules/payment/index.ts";
replaceOnce(
  paymentPath,
  `  return getDb().transaction(async (tx) => {
    if (patch.qrFileId) await lockPaymentQrReference(tx, patch.qrFileId);
    const [method] = await tx`,
  `  return getDb().transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, id))
      .limit(1);
    if (!candidate) throw new ApiError(404, "paymentMethodNotFound");
    if (patch.qrFileId) await lockPaymentQrReference(tx, patch.qrFileId);
    const [method] = await tx`,
);
replaceOnce(
  paymentPath,
  `  return getDb().transaction(async (tx) => {
    await acquirePendingPaymentLock(tx, input.userId);
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(and(eq(paymentRequests.id, input.requestId), eq(paymentRequests.userId, input.userId)))
      .limit(1)
      .for("update");
    if (!request) throw new ApiError(404, "paymentRequestNotFound");
    if (request.status !== "rejected") throw new ApiError(400, "resubmitRejectedOnly");
    await lockOwnProofReference(tx, input.proofFileId, input.userId);`,
  `  return getDb().transaction(async (tx) => {
    await acquirePendingPaymentLock(tx, input.userId);
    const [candidate] = await tx
      .select({ status: paymentRequests.status })
      .from(paymentRequests)
      .where(and(eq(paymentRequests.id, input.requestId), eq(paymentRequests.userId, input.userId)))
      .limit(1);
    if (!candidate) throw new ApiError(404, "paymentRequestNotFound");
    if (candidate.status !== "rejected") throw new ApiError(400, "resubmitRejectedOnly");
    await lockOwnProofReference(tx, input.proofFileId, input.userId);
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(and(eq(paymentRequests.id, input.requestId), eq(paymentRequests.userId, input.userId)))
      .limit(1)
      .for("update");
    if (!request) throw new ApiError(404, "paymentRequestNotFound");
    if (request.status !== "rejected") throw new ApiError(400, "resubmitRejectedOnly");`,
);

replaceOnce(
  "src/modules/payment/proof-lifecycle.ts",
  `  return getDb().transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, input.requestId))
      .limit(1)
      .for("update");
    const [file] = await tx
      .select()
      .from(files)
      .where(eq(files.id, input.fileId))
      .limit(1)
      .for("update");
    if (!file) return { note: "Payment proof already missing" };`,
  `  return getDb().transaction(async (tx) => {
    const [file] = await tx
      .select()
      .from(files)
      .where(eq(files.id, input.fileId))
      .limit(1)
      .for("update");
    if (!file) return { note: "Payment proof already missing" };
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, input.requestId))
      .limit(1)
      .for("update");`,
);
