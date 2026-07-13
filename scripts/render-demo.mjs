import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJson, resolveRepo, writeJson } from "./lib.mjs";

const shotlistPath = process.argv[2] ?? "data/deliveries/sample/shotlist.json";
const shotlist = readJson(shotlistPath);
const deliveryDir = resolveRepo("data", "deliveries", "sample");
const rawDir = resolveRepo("data", "samples", "raw");
const outDir = resolveRepo("data", "samples", "output");
const workDir = join(deliveryDir, "render-work");

ensureDir(deliveryDir);
ensureDir(rawDir);
ensureDir(outDir);
ensureDir(workDir);

function runCommand(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr);
    throw new Error(`${label} failed`);
  }
}

function run(args, label) {
  runCommand("ffmpeg", args, label);
}

function pythonBin() {
  const local = resolveRepo(".venv", "bin", "python");
  return existsSync(local) ? local : "python3";
}

function renderCardPng(specPath, pngPath) {
  runCommand(pythonBin(), [resolveRepo("scripts", "render-card.py"), specPath, pngPath], "render card");
}

function renderScene(scene, index, size, outPath) {
  const [width, height] = size.split("x").map(Number);
  const specPath = join(workDir, `${size}-scene-${String(index + 1).padStart(2, "0")}.json`);
  const pngPath = join(workDir, `${size}-scene-${String(index + 1).padStart(2, "0")}.png`);
  writeFileSync(
    specPath,
    `${JSON.stringify(
      {
        width,
        height,
        title: scene.title,
        caption: scene.caption,
        footer: `QA receipt step ${index + 1} of ${shotlist.scenes.length}`
      },
      null,
      2
    )}\n`
  );
  renderCardPng(specPath, pngPath);

  run(
    [
      "-y",
      "-loop",
      "1",
      "-i",
      pngPath,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      "-t",
      String(scene.seconds),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      outPath
    ],
    `render scene ${index + 1}`
  );
}

function concatScenes(scenePaths, outPath) {
  const listPath = join(workDir, `${outPath.endsWith("vertical.mp4") ? "vertical" : "horizontal"}-concat.txt`);
  writeFileSync(listPath, scenePaths.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
  run(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath], `concat ${outPath}`);
}

function renderVariant(kind, size, outPath) {
  const scenePaths = shotlist.scenes.map((scene, index) => {
    const path = join(workDir, `${kind}-scene-${String(index + 1).padStart(2, "0")}.mp4`);
    renderScene(scene, index, size, path);
    return path;
  });
  concatScenes(scenePaths, outPath);
}

const rawPath = join(rawDir, `${shotlist.orderId}-raw-validation.mp4`);
run(
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x111111:s=1280x720:d=8",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    rawPath
  ],
  "raw validation clip"
);

const horizontalPath = join(outDir, `${shotlist.orderId}-horizontal.mp4`);
const verticalPath = join(outDir, `${shotlist.orderId}-vertical.mp4`);
const thumbnailPath = join(outDir, `${shotlist.orderId}-thumbnail.png`);

renderVariant("horizontal", "1280x720", horizontalPath);
renderVariant("vertical", "720x1280", verticalPath);
run(["-y", "-i", horizontalPath, "-ss", "00:00:02", "-frames:v", "1", thumbnailPath], "thumbnail");

writeJson(join(deliveryDir, "render-manifest.json"), {
  orderId: shotlist.orderId,
  generatedAt: new Date().toISOString(),
  note: "Generated validation footage. Replace raw clip with real project screen recording for paid orders.",
  outputs: {
    raw: rawPath,
    horizontal: horizontalPath,
    vertical: verticalPath,
    thumbnail: thumbnailPath
  }
});

console.log(`rendered sample outputs for ${shotlist.orderId}`);
