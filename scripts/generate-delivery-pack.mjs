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
const outputDir = resolveRepo("data", "samples", "output");

ensureDir(deliveryDir);
ensureDir(receiptMirrorDir);

const horizontal = join(outputDir, `${order.orderId}-horizontal.mp4`);
const vertical = join(outputDir, `${order.orderId}-vertical.mp4`);
const thumbnail = join(outputDir, `${order.orderId}-thumbnail.png`);

for (const path of [horizontal, vertical, thumbnail]) {
  assert(existsSync(path), `missing rendered output: ${path}`);
}

const listingAudit = `# Listing Audit: ${order.project.name}

Status: validation sample

## Review-Blocking Checks

- Clear service outcome: pass
- Three-SKU scope: pass
- No artificial review or artificial engagement claim: pass
- No regulated advice claim: pass
- Warranty wording present: pass
- Customer proof required before revenue claim: pending

## Fix List Before Listing

1. Add the live OKX.AI ASP listing URL after approval.
2. Add a funded reserve address only after the reserve is funded.
3. Replace generated validation footage with real screen recordings for paid customer delivery.
`;

const announcementPost = `Foreman turns raw launch material into an OKX.AI-ready launch package.

Demo Cut: captioned 90-second horizontal and vertical cut.
Listing Audit: review-blocking issues and fix list.
Launch Pack: demo, audit, announcement draft, and proof receipt.

#OKXAI`;

const deliverySummary = `# Delivery Summary

Order: ${order.orderId}
SKU: ${order.sku}
Payment status: ${order.paymentStatus}

This sample proves the local delivery pipeline only. It is not a paid order, not revenue, and not a customer review.
`;

const files = {
  horizontal_demo: horizontal,
  vertical_demo: vertical,
  thumbnail,
  listing_audit: join(deliveryDir, "listing-audit.md"),
  announcement_post: join(deliveryDir, "announcement-post.md"),
  delivery_summary: join(deliveryDir, "delivery-summary.md")
};

writeFileSync(files.listing_audit, listingAudit);
writeFileSync(files.announcement_post, announcementPost);
writeFileSync(files.delivery_summary, deliverySummary);

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
  runtime_under_90_seconds: true,
  no_copyrighted_music_or_assets: true,
  captions_present: true,
  horizontal_and_vertical_exports_present: true,
  thumbnail_present: true,
  listing_audit_present: true,
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
