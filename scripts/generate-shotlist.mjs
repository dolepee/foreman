import { readJson, writeJson } from "./lib.mjs";

const orderPath = process.argv[2] ?? "data/orders/sample-order.json";
const outPath = process.argv[3] ?? "data/deliveries/sample/shotlist.json";
const order = readJson(orderPath);

const scenes = [
  {
    title: "Raw launch material arrives",
    caption: "A builder sends rough clips, a repo, and a deadline.",
    seconds: 15,
    tone: "problem"
  },
  {
    title: "Foreman scopes the launch job",
    caption: "Scope, deliverables, price, revision window, and warranty are written first.",
    seconds: 15,
    tone: "process"
  },
  {
    title: "Demo Cut",
    caption: "Raw footage becomes a captioned 90-second horizontal and vertical cut.",
    seconds: 15,
    tone: "output"
  },
  {
    title: "Listing Audit",
    caption: "The OKX.AI service page is checked for review blockers and unclear claims.",
    seconds: 15,
    tone: "output"
  },
  {
    title: "Launch Pack",
    caption: "Foreman packages the X post draft, thumbnail, audit notes, and proof receipt.",
    seconds: 15,
    tone: "output"
  },
  {
    title: "Delivery receipt",
    caption: "Hashes, QA checks, and warranty state make the delivery easy to verify.",
    seconds: 15,
    tone: "proof"
  }
];

writeJson(outPath, {
  orderId: order.orderId,
  projectName: order.project.name,
  targetSeconds: 90,
  format: "horizontal_and_vertical",
  generatedAt: new Date().toISOString(),
  scenes
});

console.log(`shot list written: ${outPath}`);
