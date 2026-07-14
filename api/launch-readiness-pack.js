const INPUT_ALIASES = {
  projectName: ["projectName", "project", "name", "agentName", "productName"],
  category: ["category", "track", "serviceCategory"],
  summary: ["summary", "description", "projectDescription", "overview", "whatItDoes", "useCase"],
  targetUser: ["targetUser", "targetUsers", "audience", "customer", "idealCustomer", "whoIsItFor"],
  listingDraft: ["listingDraft", "listing", "listingDescription", "serviceDescription", "agentDescription"],
  liveUrl: ["liveUrl", "url", "projectUrl", "website", "endpoint", "serviceUrl", "listingUrl", "liveListing", "demoUrl"],
  notes: ["notes", "concerns", "goals", "question", "focus", "reviewRequest", "requirements", "brief", "secondOpinion"],
  deadline: ["deadline", "dueDate", "submissionDeadline", "launchDate"],
};

const CONTAINER_KEYS = new Set(["input", "data", "payload", "request", "parameters", "arguments", "context"]);
const SENSITIVE_KEY = /(authorization|cookie|password|secret|signature|private.?key|payment)/i;

import { createChainService } from "./lib/chain.js";
import { PAYMENT, paymentRequirements } from "./lib/config.js";
import {
  createPaymentService,
  PaymentConfigurationError,
  PaymentVerificationError,
} from "./lib/payment.js";

function readInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return emptyInput();
  }
  const records = collectRecords(body);
  const input = Object.fromEntries(
    Object.entries(INPUT_ALIASES).map(([field, aliases]) => [field, readAlias(records, aliases)]),
  );
  const rawText = readAlias(records, ["prompt", "content", "task", "query", "message"]);

  input.projectName ||= readLabel(rawText, ["project", "agent", "name"]);
  input.summary ||= readLabel(rawText, ["summary", "description", "what it does", "use case"]);
  input.targetUser ||= readLabel(rawText, ["target user", "target users", "audience", "who it is for"]);
  input.liveUrl ||= readLabel(rawText, ["live url", "url", "website", "listing"]);
  input.notes ||= rawText;
  input.providedContext = collectContext(records);
  return input;
}

function emptyInput() {
  return {
    projectName: "",
    category: "",
    summary: "",
    targetUser: "",
    listingDraft: "",
    liveUrl: "",
    notes: "",
    deadline: "",
    providedContext: [],
  };
}

function collectRecords(body) {
  const records = [body];
  const queue = [{ value: body, depth: 0 }];
  const seen = new Set([body]);
  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    if (depth >= 3) continue;
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== "object" || Array.isArray(child) || seen.has(child)) continue;
      if (CONTAINER_KEYS.has(key) || depth === 0) {
        records.push(child);
        queue.push({ value: child, depth: depth + 1 });
        seen.add(child);
      }
    }
  }
  return records;
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readAlias(records, aliases) {
  const wanted = new Set(aliases.map(normalizeKey));
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!wanted.has(normalizeKey(key))) continue;
      const cleaned = clean(value);
      if (cleaned) return cleaned;
    }
  }
  return "";
}

function readLabel(text, labels) {
  if (!text) return "";
  for (const label of labels) {
    const pattern = new RegExp(`(?:^|[\\n;])\\s*${label.replace(/\s+/g, "\\s+")}\\s*[:=-]\\s*([^\\n;]+)`, "i");
    const match = text.match(pattern);
    if (match) return clean(match[1]);
  }
  return "";
}

function collectContext(records) {
  const context = [];
  const seen = new Set();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (SENSITIVE_KEY.test(key) || value === null || typeof value === "object") continue;
      const cleaned = clean(value, 300);
      const normalized = normalizeKey(key);
      if (!cleaned || seen.has(normalized)) continue;
      context.push({ field: clean(key, 60), value: cleaned });
      seen.add(normalized);
      if (context.length >= 12) return context;
    }
  }
  return context;
}

function clean(value, limit = 1200) {
  if (typeof value === "object") return "";
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function validateInput(input) {
  const errors = [];
  if (!input.projectName) errors.push("projectName is required");
  if (!input.summary && !input.listingDraft && !input.liveUrl && !input.notes) {
    errors.push("Provide a summary, listing draft, live URL, or review notes");
  }
  return errors;
}

function excerpt(value, limit = 150) {
  const cleaned = clean(value, limit + 1);
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1).trimEnd()}…` : cleaned;
}

function meaningfulWords(value) {
  return new Set(
    clean(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 5 && !["agent", "service", "users", "using", "their", "about"].includes(word)),
  );
}

function listingMatchesSummary(input) {
  if (!input.listingDraft || !input.summary) return null;
  const summaryWords = meaningfulWords(input.summary);
  const listingWords = meaningfulWords(input.listingDraft);
  if (summaryWords.size === 0) return null;
  const overlap = [...summaryWords].filter((word) => listingWords.has(word)).length;
  return overlap / summaryWords.size >= 0.25;
}

function deadlineState(deadline) {
  if (!deadline) return { state: "not_provided", evidence: "No deadline was supplied." };
  const parsed = Date.parse(deadline);
  if (Number.isNaN(parsed)) return { state: "needs_clarification", evidence: `Could not parse deadline: ${deadline}` };
  if (parsed <= Date.now()) return { state: "passed", evidence: `Submitted deadline has passed: ${deadline}` };
  return { state: "upcoming", evidence: `Submitted deadline is upcoming: ${deadline}` };
}

function safetyClaims(input) {
  const combined = `${input.summary} ${input.listingDraft}`;
  return [...combined.matchAll(/\b(guaranteed win|guaranteed approval|risk[- ]free|official partner|best on the market)\b/gi)]
    .map((match) => match[0].toLowerCase());
}

function buildXPost({ name, targetUser, summary, liveUrl }) {
  const suffix = " #OKXAI";
  const body = `Launching ${name} on OKX.AI for ${targetUser}. ${summary} Foreman checked the listing-output match, demo path, deadline, and proof surface.${liveUrl ? ` ${liveUrl}` : ""}`;
  return `${excerpt(body, 280 - suffix.length)}${suffix}`;
}

function buildPack(input) {
  const name = input.projectName;
  const hasListing = Boolean(input.listingDraft);
  const hasUrl = Boolean(input.liveUrl);
  const targetUser = input.targetUser || "the intended buyer";
  const summary = input.summary || input.notes || input.listingDraft;
  const deadline = deadlineState(input.deadline);
  const listingMatch = listingMatchesSummary(input);
  const unsafeClaims = safetyClaims(input);
  const findings = [
    {
      check: "project_identity",
      status: "pass",
      evidence: `Project identified as ${name}.`,
      action: `Use ${name} consistently in the listing, demo, and proof surface.`,
    },
    {
      check: "buyer_clarity",
      status: input.targetUser ? "pass" : "needs_input",
      evidence: input.targetUser ? `Target user supplied: ${input.targetUser}` : "No target user was supplied.",
      action: input.targetUser
        ? `Open the demo with the problem ${name} solves for ${input.targetUser}.`
        : `Name one primary buyer for ${name} before publishing launch copy.`,
    },
    {
      check: "listing_output_match",
      status: !hasListing ? "needs_input" : listingMatch === false ? "mismatch_risk" : "pass",
      evidence: !hasListing
        ? "No listing draft was supplied for comparison."
        : listingMatch === false
          ? "The listing draft shares too little concrete language with the submitted product summary."
          : "The listing draft is present and reflects the submitted product context.",
      action: !hasListing
        ? `Attach ${name}'s exact marketplace listing copy before the final submission.`
        : listingMatch === false
          ? `Rewrite ${name}'s first listing sentence around this delivered capability: ${excerpt(summary, 110)}`
          : `Keep ${name}'s delivered output inside the scope stated in the listing.`,
    },
    {
      check: "public_runtime",
      status: hasUrl ? "pass_unverified" : "needs_input",
      evidence: hasUrl ? `Submitted public surface: ${input.liveUrl}` : "No live URL or endpoint was supplied.",
      action: hasUrl
        ? `Show ${input.liveUrl} responding during the proof segment; this pack does not claim to have crawled it.`
        : `Add ${name}'s live listing or endpoint URL to the launch proof.`,
    },
    {
      check: "deadline",
      status: deadline.state,
      evidence: deadline.evidence,
      action: deadline.state === "passed"
        ? `Replace the expired date before presenting ${name} as submission-ready.`
        : deadline.state === "needs_clarification"
          ? "Use an ISO-8601 deadline so the launch clock can be verified."
          : deadline.state === "not_provided"
            ? "Add a concrete launch deadline before recording the final demo."
            : "Keep the stated launch deadline visible in the final checklist.",
    },
    {
      check: "claim_safety",
      status: unsafeClaims.length > 0 ? "mismatch_risk" : "pass",
      evidence: unsafeClaims.length > 0
        ? `Potentially unsafe claims found: ${unsafeClaims.join(", ")}.`
        : "No approval, prize, partnership, or risk-free guarantee phrase was detected in the supplied copy.",
      action: unsafeClaims.length > 0
        ? "Remove or qualify each claim unless a buyer-verifiable source supports it."
        : "Keep claims bounded to behavior a buyer can reproduce.",
    },
  ];
  if (input.notes) {
    findings.push({
      check: "buyer_review_focus",
      status: "addressed",
      evidence: `Buyer asked Foreman to focus on: ${excerpt(input.notes, 180)}`,
      action: `Resolve that focus explicitly in ${name}'s next update and show the before/after in the demo.`,
    });
  }
  const blocking = findings.filter((finding) => ["mismatch_risk", "passed"].includes(finding.status)).length;
  const missing = findings.filter((finding) => finding.status === "needs_input").length;

  return {
    verdict: blocking > 0 ? "not_ready" : missing > 0 ? "ready_after_missing_inputs" : "ready_with_minor_fixes",
    project: {
      name,
      category: input.category || "Not supplied",
      targetUser,
      summary,
    },
    listingCheck: {
      findingCount: findings.length,
      blockingCount: blocking,
      missingInputCount: missing,
      findings,
    },
    demoShotlist90s: [
      `0-8s: name the buyer and pain — ${name} helps ${targetUser}.`,
      `8-22s: show the product doing this concrete job: ${excerpt(summary, 120)}`,
      "22-35s: show the paid OKX.AI request and the 0.5 USDT service price.",
      `35-55s: show Foreman's verdict and the highest-priority finding for ${name}.`,
      hasUrl
        ? `55-72s: open ${input.liveUrl} and prove the claimed output on the live surface.`
        : `55-72s: show ${name}'s actual output and add the missing public URL before recording.`,
      `72-84s: show ${name}'s listing promise beside one matching delivery receipt.`,
      `84-90s: close with one buyer action for ${targetUser} and #OKXAI.`,
    ],
    xPostDraft: buildXPost({ name, targetUser, summary, liveUrl: input.liveUrl }),
    proofChecklist: [
      hasUrl ? `Capture ${input.liveUrl} returning the output claimed for ${name}.` : `Publish a live URL for ${name}.`,
      `Put ${name}'s marketplace promise beside one matching delivery artifact.`,
      `Show the paid request and receipt without exposing signatures, private keys, or cookies.`,
      `Show one real buyer path for ${targetUser}, including the failure state.`,
      input.deadline ? `Display and verify the submitted deadline: ${input.deadline}.` : "Add a concrete launch deadline.",
    ],
    priorityActions: findings
      .filter((finding) => ["needs_input", "mismatch_risk", "passed", "needs_clarification", "not_provided"].includes(finding.status))
      .map((finding) => finding.action)
      .slice(0, 5),
    personalization: {
      fieldsUsed: Object.entries(input)
        .filter(([key, value]) => key !== "providedContext" && Boolean(value))
        .map(([key]) => key),
      suppliedContext: input.providedContext,
    },
  };
}

function sendJson(res, status, payload) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(payload));
}

function absoluteUrl(req) {
  const host = header(req, "x-forwarded-host") || header(req, "host") || "foreman-nu-one.vercel.app";
  const proto = header(req, "x-forwarded-proto") || "https";
  return req.url?.startsWith("http") ? req.url : `${proto}://${host}${req.url || "/api/launch-readiness-pack"}`;
}

function header(req, name) {
  const direct = req.headers?.[name] ?? req.headers?.[name.toLowerCase()] ?? req.headers?.[name.toUpperCase()];
  return Array.isArray(direct) ? direct[0] : direct || "";
}

function encodeHeader(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function paymentRequired(req, res, error = "Payment required") {
  const requirements = paymentRequirements();
  const challenge = {
    x402Version: 2,
    resource: {
      url: absoluteUrl(req),
      description: "Foreman Launch Readiness Pack API",
      mimeType: "application/json",
    },
    accepts: [requirements],
  };
  res.setHeader("PAYMENT-REQUIRED", encodeHeader(challenge));
  return sendJson(res, 402, {
    ...challenge,
    error,
    charged: false,
  });
}

export function createHandler(dependencies = {}) {
  let runtimePayment = dependencies.payment;
  const getPayment = () => (runtimePayment ||= createPaymentService({ chain: createChainService() }));

  return async function handler(req, res) {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method === "HEAD") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE");
      res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
      res.status(200).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }

    const input = readInput(req.method === "POST" ? req.body : req.query);
    const inputErrors = validateInput(input);
    if (req.method === "POST" && inputErrors.length > 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "insufficient_project_context",
        details: inputErrors,
        charged: false,
      });
    }

    const rawPayment = header(req, "payment-signature");
    if (!rawPayment) return paymentRequired(req, res);

    if (inputErrors.length > 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "insufficient_project_context",
        details: inputErrors,
        charged: false,
      });
    }

    const requirements = paymentRequirements();
    let verified;
    let payment;
    try {
      payment = getPayment();
      verified = await payment.verify(rawPayment, requirements);
    } catch (error) {
      if (error instanceof PaymentConfigurationError) {
        return sendJson(res, 503, { ok: false, error: "payment_service_not_ready", charged: false });
      }
      return paymentRequired(req, res, error instanceof PaymentVerificationError ? error.code : "payment_verification_failed");
    }

    const result = buildPack(input);
    let settlement;
    try {
      settlement = await payment.settle(verified, requirements);
    } catch (error) {
      return paymentRequired(req, res, error instanceof PaymentVerificationError ? error.code : "payment_settlement_failed");
    }

    res.setHeader("PAYMENT-RESPONSE", settlement.responseHeader);
    res.setHeader("X-PAYMENT-RESPONSE", settlement.responseHeader);
    return sendJson(res, 200, {
      ok: true,
      agent: "Foreman",
      service: "Launch Readiness Pack",
      mode: "api_service",
      generatedAt: new Date().toISOString(),
      input,
      result,
      servicePayment: {
        settled: true,
        network: settlement.network,
        transaction: settlement.transaction,
        payer: settlement.payer,
        amountAtomic: settlement.amount,
        transfer: settlement.transfer,
      },
    });
  };
}

export default createHandler();
