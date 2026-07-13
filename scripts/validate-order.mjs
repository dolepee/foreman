import { existsSync } from "node:fs";
import { assert, allowedSkus, lockedWarranty, readJson } from "./lib.mjs";

const orderPath = process.argv[2] ?? "data/orders/sample-order.json";
const order = readJson(orderPath);

assert(typeof order.orderId === "string" && order.orderId.length >= 3, "orderId is required");
assert(order.buyer && typeof order.buyer.name === "string", "buyer.name is required");
assert(allowedSkus.has(order.sku), `unsupported sku: ${order.sku}`);
assert(Number.isFinite(order.priceUSDT) && order.priceUSDT >= 0, "priceUSDT must be a non-negative number");
assert(typeof order.paymentStatus === "string", "paymentStatus is required");
assert(order.project && typeof order.project.name === "string", "project.name is required");
assert(typeof order.project.summary === "string" && order.project.summary.length >= 20, "project.summary is too short");
assert(Array.isArray(order.deliverables) && order.deliverables.length > 0, "deliverables are required");
assert(typeof order.scope === "string" && order.scope.length >= 30, "scope is too short");
assert(order.warranty === lockedWarranty, "warranty sentence must match locked policy exactly");

for (const rawPath of order.rawMaterials ?? []) {
  assert(existsSync(rawPath), `raw material missing: ${rawPath}`);
}

console.log(`valid order: ${order.orderId} (${order.sku})`);
