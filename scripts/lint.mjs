import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { listFilesRecursive, rel, resolveRepo } from "./lib.mjs";

const bannedPhrases = [
  "guaranteed win",
  "guaranteed approval",
  "guaranteed success",
  "partners",
  "we do everything",
  "fake reviews",
  "engagement farming"
];

const forbiddenFilePatterns = [
  /(^|\/)demo[-_]?script\./i,
  /(^|\/)DEMO_SCRIPT\.md$/i,
  /(^|\/).*SUBMISSION.*\.md$/i,
  /(^|\/)submission[-_]?checklist\./i
];

const files = listFilesRecursive(resolveRepo("."))
  .filter((path) => !path.includes("/.git/"))
  .filter((path) => !path.includes("/.agents/"))
  .filter((path) => !path.includes("/.venv/"))
  .filter((path) => !path.endsWith("/scripts/lint.mjs"))
  .filter((path) => !path.includes("/data/samples/output/"))
  .filter((path) => !path.includes("/data/samples/raw/"))
  .filter((path) => !path.includes("/data/deliveries/"))
  .filter((path) => !path.includes("/data/receipts/"))
  .filter((path) => /\.(md|json|mjs|html|css|txt)$/.test(path));

let failures = 0;

for (const path of files) {
  const relative = rel(path);
  if (forbiddenFilePatterns.some((pattern) => pattern.test(relative))) {
    console.error(`forbidden private submission/demo file: ${relative}`);
    failures += 1;
  }

  const text = readFileSync(path, "utf8").toLowerCase();
  for (const phrase of bannedPhrases) {
    if (text.includes(phrase)) {
      const allowed =
        basename(path) === "README.md" && ["fake reviews", "engagement farming"].includes(phrase);
      if (!allowed) {
        console.error(`banned phrase "${phrase}" in ${relative}`);
        failures += 1;
      }
    }
  }
}

if (failures > 0) process.exit(1);
console.log(`lint passed: ${files.length} files checked`);
