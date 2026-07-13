import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = new URL("..", import.meta.url);
export const repoPath = fileURLToPath(repoRoot);

export function resolveRepo(...parts) {
  return join(repoPath, ...parts);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) out.push(...listFilesRecursive(path));
    if (stats.isFile()) out.push(path);
  }
  return out;
}

export function rel(path) {
  return relative(repoPath, path);
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function escapeDrawtext(text) {
  return String(text)
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll("%", "\\%");
}

export const lockedWarranty =
  "If the delivered asset misses the written scope and we cannot fix it within the revision window, we refund the service fee.";

export const allowedSkus = new Set(["demo_cut", "listing_audit", "launch_pack"]);
