import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, before, after) {
  const current = readFileSync(path, "utf8");
  const count = current.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one target, found ${count}`);
  writeFileSync(path, current.replace(before, after));
}

replaceOnce(
  "src/modules/content/publishing.integration.test.ts",
  `          originalName: "latest.txt",
          mimeType: "text/plain",
          sizeBytes: 20,
          purpose: "content_attachment",`,
  `          originalName: "latest.png",
          mimeType: "image/png",
          sizeBytes: 20,
          purpose: "content_image",`,
);
replaceOnce(
  "src/modules/content/publishing.integration.test.ts",
  `    await attachFileToPost({ postId: original.id, fileId: secondFile!.id, kind: "attachment" });`,
  `    await attachFileToPost({ postId: original.id, fileId: secondFile!.id, kind: "image" });`,
);
replaceOnce(
  "src/modules/file/deletion-references.integration.test.ts",
  `  it("blocks deletion when a protected site setting references the file", async () => {
    const file = await seedFile("content_image");`,
  `  it("blocks deletion when a protected site setting references the file", async () => {
    const file = await seedFile("artist_avatar");`,
);
