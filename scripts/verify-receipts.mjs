import { existsSync } from "node:fs";
import { assert, listFilesRecursive, readJson, resolveRepo, sha256File } from "./lib.mjs";

const receiptDir = resolveRepo("data", "receipts");
const receipts = listFilesRecursive(receiptDir).filter((path) => path.endsWith(".json"));

assert(receipts.length > 0, "no receipts found; run npm run delivery:pack first");

for (const path of receipts) {
  const receipt = readJson(path);
  assert(receipt.orderId, `orderId missing in ${path}`);
  assert(receipt.outputs, `outputs missing in ${path}`);
  for (const [name, output] of Object.entries(receipt.outputs)) {
    assert(existsSync(output.path), `output missing for ${receipt.orderId}: ${name}`);
    assert(sha256File(output.path) === output.sha256, `hash mismatch for ${receipt.orderId}: ${name}`);
  }
  assert(receipt.warning?.includes("local validation sample") || receipt.okx?.orderReceipt, `${receipt.orderId} has no OKX order proof and is not sample-labeled`);
}

console.log(`verified receipts: ${receipts.length}`);
