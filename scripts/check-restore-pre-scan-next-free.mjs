import { readFile } from "node:fs/promises";

const forbiddenMarkers = ["next/server", "next/dist/server/"];
const artifacts =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [
        "restore-pre-scan.mjs",
        "restore-neutralize.mjs",
        "restore-converge.mjs",
        "restore-schema-check.mjs",
        "restore-config-key-probe.mjs",
      ].map((name) => new URL(`../dist/${name}`, import.meta.url));

for (const artifact of artifacts) {
  const source = await readFile(artifact, "utf8");
  const marker = forbiddenMarkers.find((candidate) => source.includes(candidate));
  if (marker) {
    throw new Error(`${artifact} unexpectedly bundles Next server runtime (${marker})`);
  }
}

console.log(`Verified ${artifacts.length} restore artifact(s) are Next-free.`);
