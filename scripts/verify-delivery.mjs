import { existsSync } from "node:fs";
import { assert, readJson, sha256File } from "./lib.mjs";

const receiptPath = process.argv[2] ?? "data/deliveries/sample/receipt.json";
const receipt = readJson(receiptPath);

assert(receipt.orderId, "receipt.orderId missing");
assert(receipt.scopeHash, "receipt.scopeHash missing");
assert(receipt.outputs && Object.keys(receipt.outputs).length > 0, "receipt.outputs missing");

for (const [name, output] of Object.entries(receipt.outputs)) {
  assert(existsSync(output.path), `output missing: ${name}`);
  const actual = sha256File(output.path);
  assert(actual === output.sha256, `hash mismatch for ${name}`);
}

for (const [check, value] of Object.entries(receipt.qa ?? {})) {
  assert(value === true, `QA check failed: ${check}`);
}

assert(receipt.warning?.includes("local validation sample") || receipt.okx?.orderReceipt, "receipt must be either sample-labeled or backed by OKX order proof");
console.log(`delivery verified: ${receipt.orderId}`);
