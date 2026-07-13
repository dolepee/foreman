import { spawnSync } from "node:child_process";

const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });

if (result.status !== 0) {
  console.error("ffmpeg is required for Foreman demo rendering.");
  console.error("Install with: brew install ffmpeg");
  process.exit(1);
}

const firstLine = result.stdout.split("\n")[0];
console.log(`ffmpeg available: ${firstLine}`);
