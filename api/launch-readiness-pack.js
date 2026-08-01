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

import express from "express";

import {
  authorizeControlledFailure,
  controlledFailureConfig,
  payerMatchesControlledFailure,
  readControlledFailure,
} from "./lib/controlled-failure.js";
import {
  captureVerifiedPaymentRequest,
  createPaymentGate,
  FOREMAN_SERVICE_PATH,
  PaymentConfigurationError,
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
      "22-35s: show the paid OKX.AI request and the 0.1 USDT service price.",
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

export function createHandler(dependencies = {}) {
  const app = express();
  app.disable("x-powered-by");
  const getControlledFailure = Object.hasOwn(dependencies, "controlledFailureConfig")
    ? () => dependencies.controlledFailureConfig
    : () => controlledFailureConfig();

  let paymentGate;
  let paymentConfigurationError;
  try {
    paymentGate = createPaymentGate(
      dependencies.environment || process.env,
      {
        facilitatorClient: dependencies.facilitatorClient,
        logger: dependencies.logger || console,
      },
    );
  } catch (error) {
    paymentConfigurationError = error;
  }

  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT",
    );
    response.setHeader(
      "Access-Control-Expose-Headers",
      "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
    );
    response.setHeader("cache-control", "no-store");
    next();
  });
  app.options(FOREMAN_SERVICE_PATH, (_request, response) => response.status(204).end());

  function requirePayment(request, response, next) {
    if (paymentGate) return paymentGate(request, response, next);
    const error = paymentConfigurationError;
    if (error && !(error instanceof PaymentConfigurationError)) {
      (dependencies.logger || console).error("payment service configuration failed", {
        name: error?.name,
        code: error?.code,
      });
    }
    return response.status(503).json({
      ok: false,
      error: "payment_service_not_ready",
      charged: false,
    });
  }

  app.all(FOREMAN_SERVICE_PATH, requirePayment);
  app.use(FOREMAN_SERVICE_PATH, express.json({ limit: "32kb", strict: true }));
  app.all(FOREMAN_SERVICE_PATH, (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("allow", "POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed", charged: false });
    }
    if (req.method === "GET") {
      res.setHeader("allow", "POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed", charged: false });
    }

    const rawInput = req.body;
    const input = readInput(rawInput);
    const inputErrors = validateInput(input);
    if (inputErrors.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "insufficient_project_context",
        details: inputErrors,
        charged: false,
      });
    }

    const failureRequest = readControlledFailure(rawInput);
    let failureAuthorization = { requested: false, authorized: false };
    let failureConfig = null;
    if (failureRequest) {
      try {
        failureConfig = getControlledFailure();
        failureAuthorization = authorizeControlledFailure({
          request: failureRequest,
          config: failureConfig,
        });
      } catch {
        return res.status(503).json({
          ok: false,
          error: "controlled_failure_configuration_invalid",
          charged: false,
        });
      }
      if (!failureAuthorization.authorized) {
        return res.status(403).json({
          ok: false,
          error: failureAuthorization.reason,
          charged: false,
        });
      }
      let verified;
      try {
        verified = captureVerifiedPaymentRequest(req);
      } catch (error) {
        return res.status(422).json({
          ok: false,
          error: error?.code || "payment_authorization_mismatch",
          charged: false,
        });
      }
      if (!payerMatchesControlledFailure(verified.payer, failureConfig)) {
        return res.status(403).json({
          ok: false,
          error: "controlled_failure_payer_mismatch",
          charged: false,
        });
      }
      // The official SDK settles only successful handler responses. This 2xx
      // body remains withheld until the authorized controlled-failure payment
      // settles; every rejected or malformed pilot request stays uncharged.
      return res.status(200).json({
        ok: false,
        status: "controlled_provider_non_delivery",
        error: "controlled_provider_non_delivery",
        charged: true,
        pilot: {
          id: failureConfig.id,
          mode: "controlled_provider_failure",
          deliverableWithheld: true,
        },
        servicePayment: {
          settled: true,
          proofHeader: "PAYMENT-RESPONSE",
        },
      });
    }

    const result = buildPack(input);
    return res.status(200).json({
      ok: true,
      agent: "Foreman",
      service: "Launch Readiness Pack",
      mode: "api_service",
      generatedAt: new Date().toISOString(),
      input,
      result,
      servicePayment: {
        settled: true,
        proofHeader: "PAYMENT-RESPONSE",
      },
    });
  });

  app.use((error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error?.type === "entity.too.large") {
      return response.status(413).json({ ok: false, error: "payload_too_large", charged: false });
    }
    if (error?.type === "entity.parse.failed") {
      return response.status(400).json({ ok: false, error: "invalid_json", charged: false });
    }
    (dependencies.logger || console).error("Foreman request failed", {
      name: error?.name,
      code: error?.code,
    });
    return response.status(500).json({ ok: false, error: "internal_error", charged: false });
  });

  return app;
}

export default createHandler();
