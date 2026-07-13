const DEFAULT_INPUT = {
  projectName: "OKX.AI agent launch",
  category: "Software Services",
  summary: "Agent service preparing for OKX.AI listing review.",
  targetUser: "Agent builders and marketplace service providers",
};

import { createChainService } from "./lib/chain.js";
import { PAYMENT, paymentRequirements } from "./lib/config.js";
import {
  createPaymentService,
  PaymentConfigurationError,
  PaymentVerificationError,
} from "./lib/payment.js";

function readInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return DEFAULT_INPUT;
  }
  return {
    projectName: clean(body.projectName || body.name || DEFAULT_INPUT.projectName),
    category: clean(body.category || DEFAULT_INPUT.category),
    summary: clean(body.summary || body.description || body.notes || DEFAULT_INPUT.summary),
    targetUser: clean(body.targetUser || body.audience || DEFAULT_INPUT.targetUser),
    listingDraft: clean(body.listingDraft || body.listing || ""),
    liveUrl: clean(body.liveUrl || body.url || ""),
    deadline: clean(body.deadline || ""),
  };
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 600);
}

function buildPack(input) {
  const name = input.projectName || DEFAULT_INPUT.projectName;
  const hasListing = Boolean(input.listingDraft);
  const hasUrl = Boolean(input.liveUrl);

  const fixes = [
    "Keep the service promise narrow and match it exactly to the delivered output.",
    "Make the first API response deterministic and fast; do not rely on a long chat loop for verification.",
    "Show payment or usage gating in the demo so the buyer understands what is paid versus previewed.",
    "Remove approval guarantees, prize guarantees, investment advice, and unverifiable partnership claims.",
    "Include one proof screen: endpoint response, receipt hash, or delivery checklist.",
  ];

  if (!hasListing) {
    fixes.push("Add the final listing draft before submission so service/output mismatch can be checked.");
  }
  if (!hasUrl) {
    fixes.push("Add a live URL or endpoint URL if the service depends on a public runtime.");
  }

  return {
    verdict: hasListing || hasUrl ? "ready_with_minor_gaps" : "sample_ready",
    project: {
      name,
      category: input.category || DEFAULT_INPUT.category,
      targetUser: input.targetUser || DEFAULT_INPUT.targetUser,
      summary: input.summary || DEFAULT_INPUT.summary,
    },
    listingCheck: {
      scopeClarity: "pass",
      outputMatch: hasListing ? "check_draft_against_output" : "needs_final_listing_draft",
      verifierReadiness: "pass_api_path",
      riskLanguage: "avoid guarantees and regulated advice",
    },
    demoShotlist90s: [
      "0-10s: show the raw launch material or rough agent idea.",
      "10-25s: show the paid API call or OKX.AI service request.",
      "25-50s: show Foreman returning the readiness pack.",
      "50-70s: show the fix list, demo structure, and proof checklist.",
      "70-85s: show the final launch-ready copy or output pack.",
      "85-90s: close with the service name and #OKXAI.",
    ],
    xPostDraft: `Launching ${name} on OKX.AI. Foreman checked the listing, demo path, proof surface, and rejection risks, then returned a submission-ready launch pack. #OKXAI`,
    proofChecklist: [
      "Public endpoint returns 200 JSON.",
      "Response includes service verdict, fix list, demo shotlist, and proof checklist.",
      "No private keys, signatures, trades, or regulated advice are requested.",
      "Delivery output can be saved as a receipt for buyer review.",
    ],
    fixes,
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

    const rawPayment = header(req, "payment-signature");
    if (!rawPayment) return paymentRequired(req, res);

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

    const input = readInput(req.method === "POST" ? req.body : req.query);
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
