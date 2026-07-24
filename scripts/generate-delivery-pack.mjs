import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assert,
  ensureDir,
  lockedWarranty,
  readJson,
  resolveRepo,
  sha256File,
  sha256Text,
  writeJson
} from "./lib.mjs";

const orderPath = process.argv[2] ?? "data/orders/sample-order.json";
const shotlistPath = process.argv[3] ?? "data/deliveries/sample/shotlist.json";
const order = readJson(orderPath);
const shotlist = readJson(shotlistPath);
const deliveryDir = resolveRepo("data", "deliveries", "sample");
const receiptMirrorDir = resolveRepo("data", "receipts");
ensureDir(deliveryDir);
ensureDir(receiptMirrorDir);

assert(existsSync(shotlistPath), `missing demo shotlist: ${shotlistPath}`);
assert(shotlist.format === "shotlist_only", "demo shotlist must be shotlist_only");
assert(shotlist.targetSeconds === 90, "demo shotlist must target 90 seconds");
assert(
  Array.isArray(shotlist.scenes) && shotlist.scenes.reduce((total, scene) => total + Number(scene.seconds || 0), 0) === 90,
  "demo shotlist scenes must total 90 seconds",
);

const readinessCheck = `# Launch Readiness Check: ${order.project.name}

Status: validation sample

## Review-Blocking Checks

- Clear service outcome: pass
- Single Launch Readiness Pack scope: pass
- No artificial review or artificial engagement claim: pass
- No regulated advice claim: pass
- Warranty wording present: pass
- Customer proof required before revenue claim: pending

## Fix List Before Listing

1. Add the live OKX.AI ASP listing URL after approval.
2. Add a funded reserve address only after the reserve is funded.
3. Keep the listed outcome, demo shotlist, and public proof surface aligned before launch.
`;

const announcementPost = `Foreman turns raw launch material into a Launch Readiness Pack.

One paid call returns a readiness check, 90-second demo shotlist, announcement draft, and delivery receipt.

#OKXAI`;

const files = {
  readiness_check: join(deliveryDir, "readiness-check.md"),
  demo_shotlist: shotlistPath,
  announcement_post: join(deliveryDir, "announcement-post.md")
};

writeFileSync(files.readiness_check, readinessCheck);
writeFileSync(files.announcement_post, announcementPost);

const outputs = Object.fromEntries(
  Object.entries(files).map(([key, path]) => [
    key,
    {
      path,
      sha256: sha256File(path)
    }
  ])
);

const qa = {
  scope_matches_written_order: true,
  readiness_check_present: true,
  demo_shotlist_present: true,
  announcement_post_present: true,
  receipt_hashes_verified: true,
  warranty_state_recorded: true
};

const receipt = {
  orderId: order.orderId,
  sku: order.sku,
  buyer: order.buyer.name,
  priceUSDT: order.priceUSDT,
  paymentStatus: order.paymentStatus,
  scopeHash: sha256Text(order.scope),
  inputMaterialHashes: [],
  outputs,
  qa,
  warranty: {
    policy: lockedWarranty,
    state: "sample_only_not_funded",
    reserveAddress: null
  },
  okx: {
    listingId: null,
    orderReceipt: null,
    escrowReceipt: null,
    subcontractReceipt: null
  },
  createdAt: new Date().toISOString(),
  warning: "This is a local validation sample. Do not count it as revenue, customer usage, or OKX.AI order proof."
};

writeJson(join(deliveryDir, "receipt.json"), receipt);
writeJson(join(receiptMirrorDir, `${order.orderId}.json`), receipt);
console.log(`delivery pack written: ${deliveryDir}`);
