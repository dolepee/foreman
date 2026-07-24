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
    title: "Launch-readiness check",
    caption: "Foreman identifies the highest-priority listing and buyer-flow issue before the launch goes public.",
    seconds: 15,
    tone: "output"
  },
  {
    title: "90-second demo shotlist",
    caption: "A concise sequence shows the buyer problem, concrete action, proof, and call to action.",
    seconds: 15,
    tone: "output"
  },
  {
    title: "Announcement draft",
    caption: "A concise post frames the outcome and links the proof without overstating traction.",
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
  format: "shotlist_only",
  generatedAt: new Date().toISOString(),
  scenes
});

console.log(`shot list written: ${outPath}`);
