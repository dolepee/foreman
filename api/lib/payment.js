import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

import { PAYMENT, XLAYER } from "./config.js";

export const FOREMAN_SERVICE_PATH = "/api/launch-readiness-pack";
export const FOREMAN_SERVICE_RESOURCE =
  "https://foreman-nu-one.vercel.app/api/launch-readiness-pack";
export const FOREMAN_PAYMENT_TIMEOUT_SECONDS = 300;

const REQUIRED_CREDENTIALS = Object.freeze([
  "OKX_API_KEY",
  "OKX_SECRET_KEY",
  "OKX_PASSPHRASE",
]);
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-f]{130}$/;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const verifiedRequests = new WeakMap();

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const FOREMAN_INPUT_BODY_SCHEMA = deepFreeze({
  type: "object",
  properties: {
    projectName: { type: "string" },
    category: { type: "string" },
    summary: { type: "string" },
    targetUser: { type: "string" },
    listingDraft: { type: "string" },
    liveUrl: { type: "string" },
    notes: { type: "string" },
    deadline: { type: "string" },
  },
  required: ["projectName"],
  anyOf: [
    { required: ["summary"] },
    { required: ["listingDraft"] },
    { required: ["liveUrl"] },
    { required: ["notes"] },
  ],
});

// Keep the header contract deliberately compact for strict marketplace
// clients. The complete validation schema remains in the 402 JSON body.
const FOREMAN_CHALLENGE_INPUT_BODY_SCHEMA = deepFreeze({
  type: "object",
  properties: {
    projectName: { type: "string" },
    summary: { type: "string" },
    listingDraft: { type: "string" },
    liveUrl: { type: "string" },
    notes: { type: "string" },
  },
  required: ["projectName", "summary"],
});

export const FOREMAN_CHALLENGE_OUTPUT_SCHEMA = deepFreeze({
  input: {
    type: "http",
    method: "POST",
    bodyType: "json",
    body: FOREMAN_CHALLENGE_INPUT_BODY_SCHEMA,
  },
});

export const FOREMAN_OUTPUT_SCHEMA = deepFreeze({
  input: {
    type: "http",
    method: "POST",
    bodyType: "json",
    body: FOREMAN_INPUT_BODY_SCHEMA,
  },
  output: {
    type: "json",
    description:
      "Launch Readiness Pack with listing checks, a demo shotlist, an announcement draft, and a delivery receipt.",
  },
});

export const FOREMAN_USAGE_EXAMPLE = deepFreeze({
  projectName: "AgentForge",
  summary: "Checks launch readiness for an OKX.AI agent service.",
  targetUser: "OKX.AI service providers",
  notes: "Check whether the listing promise matches the delivered endpoint output.",
});

export class PaymentConfigurationError extends Error {
  constructor(message, { missing = [], padded = [] } = {}) {
    super(message);
    this.name = "PaymentConfigurationError";
    this.code = "payment_configuration_error";
    this.missing = Object.freeze([...missing]);
    this.padded = Object.freeze([...padded]);
  }
}

function paymentAuthorizationMismatch(message) {
  const error = new Error(message);
  error.code = "payment_authorization_mismatch";
  return error;
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join("\n") === expected.join("\n");
}

function paymentHeader(request) {
  const paymentSignature =
    request.get?.("payment-signature") ??
    request.headers?.["payment-signature"];
  const legacy = request.get?.("x-payment") ?? request.headers?.["x-payment"];
  if (
    paymentSignature &&
    legacy &&
    String(paymentSignature) !== String(legacy)
  ) {
    throw paymentAuthorizationMismatch(
      "Conflicting x402 payment headers are not accepted",
    );
  }
  return paymentSignature || legacy || "";
}

function decodePaymentHeader(value) {
  const text = String(value || "");
  if (text.startsWith("{")) {
    try {
      const decoded = JSON.parse(text);
      if (!plainObject(decoded)) throw new Error("invalid");
      return decoded;
    } catch {
      throw paymentAuthorizationMismatch("Verified x402 payment header is invalid");
    }
  }
  if (
    !text ||
    text !== text.trim() ||
    !BASE64_RE.test(text) ||
    text.length % 4 !== 0
  ) {
    throw paymentAuthorizationMismatch("Verified x402 payment header is invalid");
  }
  const bytes = Buffer.from(text, "base64");
  if (
    bytes.length === 0 ||
    bytes.toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")
  ) {
    throw paymentAuthorizationMismatch(
      "Verified x402 payment header is not canonical",
    );
  }
  try {
    const decoded = JSON.parse(bytes.toString("utf8"));
    if (!plainObject(decoded)) throw new Error("invalid");
    return decoded;
  } catch {
    throw paymentAuthorizationMismatch("Verified x402 payment header is invalid");
  }
}

export function readFacilitatorCredentials(environment = process.env) {
  const credentials = {};
  const missing = [];
  const padded = [];

  for (const name of REQUIRED_CREDENTIALS) {
    const value = typeof environment[name] === "string" ? environment[name] : "";
    if (!value.trim()) {
      missing.push(name);
    } else if (value !== value.trim()) {
      padded.push(name);
    } else {
      credentials[name] = value;
    }
  }

  if (missing.length > 0 || padded.length > 0) {
    throw new PaymentConfigurationError(
      "Foreman payment service credentials are incomplete",
      { missing, padded },
    );
  }

  return Object.freeze({
    apiKey: credentials.OKX_API_KEY,
    secretKey: credentials.OKX_SECRET_KEY,
    passphrase: credentials.OKX_PASSPHRASE,
    syncSettle: true,
  });
}

function acceptedRequirements() {
  return Object.freeze({
    scheme: "exact",
    network: XLAYER.network,
    amount: PAYMENT.amount,
    asset: PAYMENT.asset.toLowerCase(),
    payTo: PAYMENT.payTo.toLowerCase(),
    maxTimeoutSeconds: FOREMAN_PAYMENT_TIMEOUT_SECONDS,
    extra: Object.freeze({
      name: PAYMENT.name,
      version: PAYMENT.version,
      decimals: PAYMENT.decimals,
    }),
  });
}

export function unpaidServiceDiscoveryBody() {
  const requirements = acceptedRequirements();
  return Object.freeze({
    x402Version: 2,
    ok: false,
    error: Object.freeze({
      code: "payment_required",
      message:
        "Payment is required for one Launch Readiness Pack; use accepts[0] for the exact asset and amount",
    }),
    resource: Object.freeze({
      url: FOREMAN_SERVICE_RESOURCE,
      description:
        "Create one Launch Readiness Pack from buyer-supplied project context.",
      mimeType: "application/json",
    }),
    accepts: Object.freeze([requirements]),
    outputSchema: FOREMAN_OUTPUT_SCHEMA,
    inputSchema: FOREMAN_INPUT_BODY_SCHEMA,
    userProvides: Object.freeze([
      "projectName",
      "one of summary, listingDraft, liveUrl, or notes",
    ]),
    usageExamples: Object.freeze([FOREMAN_USAGE_EXAMPLE]),
    charged: false,
  });
}

export function serviceRouteConfiguration() {
  return Object.freeze({
    [`* ${FOREMAN_SERVICE_PATH}`]: Object.freeze({
      accepts: Object.freeze({
        scheme: "exact",
        network: XLAYER.network,
        payTo: PAYMENT.payTo.toLowerCase(),
        price: Object.freeze({
          amount: PAYMENT.amount,
          asset: PAYMENT.asset.toLowerCase(),
          extra: Object.freeze({
            name: PAYMENT.name,
            version: PAYMENT.version,
            decimals: PAYMENT.decimals,
          }),
        }),
        maxTimeoutSeconds: FOREMAN_PAYMENT_TIMEOUT_SECONDS,
      }),
      resource: FOREMAN_SERVICE_RESOURCE,
      description:
        "Create one Launch Readiness Pack from buyer-supplied project context.",
      mimeType: "application/json",
      extensions: Object.freeze({
        outputSchema: FOREMAN_CHALLENGE_OUTPUT_SCHEMA,
      }),
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: unpaidServiceDiscoveryBody(),
      }),
      settlementFailedResponseBody: () => ({
        contentType: "application/json",
        body: {
          ok: false,
          error: {
            code: "payment_settlement_failed",
            message:
              "Payment could not be settled; the Launch Readiness Pack was not delivered",
          },
        },
      }),
    }),
  });
}

/**
 * Capture the payer only after the official payment middleware has called next.
 * The weak-map binding lets controlled-failure authorization inspect the
 * facilitator-verified payer without exposing or persisting the signature.
 */
export function captureVerifiedPaymentRequest(request) {
  if (!request || typeof request !== "object") {
    throw new TypeError("request is required");
  }
  const decoded = decodePaymentHeader(paymentHeader(request));
  const accepted = decoded.accepted;
  const payload = decoded.payload;
  const authorization = payload?.authorization;
  const extra = accepted?.extra;
  if (
    decoded.x402Version !== 2 ||
    !plainObject(accepted) ||
    !plainObject(payload) ||
    !exactKeys(payload, ["authorization", "signature"]) ||
    !plainObject(authorization) ||
    !exactKeys(authorization, [
      "from",
      "nonce",
      "to",
      "validAfter",
      "validBefore",
      "value",
    ]) ||
    !plainObject(extra) ||
    !exactKeys(extra, ["decimals", "name", "version"])
  ) {
    throw paymentAuthorizationMismatch("Verified x402 payment fields are invalid");
  }

  const requirements = acceptedRequirements();
  const payer = String(authorization.from || "").toLowerCase();
  const payee = String(authorization.to || "").toLowerCase();
  const nonce = String(authorization.nonce || "").toLowerCase();
  const signature = String(payload.signature || "").toLowerCase();
  const validAfter = String(authorization.validAfter ?? "");
  const validBefore = String(authorization.validBefore ?? "");
  if (
    accepted.scheme !== requirements.scheme ||
    accepted.network !== requirements.network ||
    String(accepted.asset || "").toLowerCase() !== requirements.asset ||
    String(accepted.amount ?? "") !== requirements.amount ||
    String(accepted.payTo || "").toLowerCase() !== requirements.payTo ||
    accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds ||
    extra.name !== requirements.extra.name ||
    extra.version !== requirements.extra.version ||
    extra.decimals !== requirements.extra.decimals ||
    !ADDRESS_RE.test(payer) ||
    payee !== requirements.payTo ||
    String(authorization.value ?? "") !== requirements.amount ||
    !UINT_RE.test(validAfter) ||
    !UINT_RE.test(validBefore) ||
    BigInt(validBefore) <= BigInt(validAfter) ||
    !HASH_RE.test(nonce) ||
    !SIGNATURE_RE.test(signature)
  ) {
    throw paymentAuthorizationMismatch(
      "Verified x402 authorization differs from the pinned Foreman service",
    );
  }

  const verified = Object.freeze({
    version: "foreman-verified-payment-request-v1",
    servicePath: FOREMAN_SERVICE_PATH,
    payer,
    nonce,
    validAfter,
    validBefore,
  });
  verifiedRequests.set(request, verified);
  return verified;
}

export function verifiedPaymentRequest(request) {
  const value = verifiedRequests.get(request);
  if (!value) {
    throw paymentAuthorizationMismatch(
      "A facilitator-verified payment request is required",
    );
  }
  return value;
}

export function createPaymentGate(
  environment = process.env,
  { facilitatorClient = undefined, logger = console } = {},
) {
  const facilitator =
    facilitatorClient ??
    new OKXFacilitatorClient(readFacilitatorCredentials(environment));
  const resourceServer = new x402ResourceServer(facilitator)
    .register(XLAYER.network, new ExactEvmScheme())
    .registerExtension({
      key: "outputSchema",
      async enrichPaymentRequiredResponse(schema, context) {
        const {
          outputSchema: _nestedOutputSchema,
          ...remainingExtensions
        } = context.paymentRequiredResponse.extensions ?? {};
        context.paymentRequiredResponse.outputSchema = schema;
        if (Object.keys(remainingExtensions).length > 0) {
          context.paymentRequiredResponse.extensions = remainingExtensions;
        } else {
          delete context.paymentRequiredResponse.extensions;
        }
      },
    })
    .onVerifyFailure(async ({ error }) => {
      logger.error("payment verification failed", {
        name: error?.name,
        code: error?.code,
      });
    })
    .onSettleFailure(async ({ error }) => {
      logger.error("payment settlement failed", {
        name: error?.name,
        code: error?.code,
      });
    });
  const httpServer = new x402HTTPResourceServer(
    resourceServer,
    serviceRouteConfiguration(),
  );
  const middleware = paymentMiddlewareFromHTTPServer(
    httpServer,
    undefined,
    undefined,
    false,
  );

  let initialized = false;
  let initializationPromise;
  async function ensureInitialized() {
    if (initialized) return;
    if (!initializationPromise) {
      initializationPromise = httpServer
        .initialize()
        .then(() => {
          initialized = true;
        })
        .catch((error) => {
          initializationPromise = undefined;
          throw error;
        });
    }
    await initializationPromise;
  }

  return async function paymentGate(request, response, next) {
    try {
      await ensureInitialized();
      return middleware(request, response, next);
    } catch (error) {
      logger.error("payment service initialization failed", {
        name: error?.name,
        code: error?.code,
      });
      response.setHeader("cache-control", "no-store");
      return response.status(503).json({
        ok: false,
        error: {
          code: "payment_service_unavailable",
          message: "Payment verification is temporarily unavailable",
        },
      });
    }
  };
}

/**
 * Use this wrapper instead of invoking the payment gate directly whenever the
 * downstream handler needs the verified payer (for example, Foreman's tightly
 * scoped controlled-failure pilot). A downstream 4xx still prevents settlement.
 */
export function continueAfterVerifiedPayment({
  paymentGate,
  request,
  response,
  next,
}) {
  return paymentGate(request, response, (error) => {
    if (error) return next(error);
    try {
      captureVerifiedPaymentRequest(request);
    } catch (captureError) {
      response.setHeader("cache-control", "no-store");
      return response.status(422).json({
        ok: false,
        error: {
          code:
            captureError?.code || "payment_authorization_mismatch",
          message:
            "The verified payment authorization differs from the pinned Foreman service",
        },
      });
    }
    return next();
  });
}
