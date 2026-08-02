import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

import { createHandler } from "../api/launch-readiness-pack.js";
import { PAYMENT, XLAYER } from "../api/lib/config.js";
import {
  FOREMAN_CHALLENGE_OUTPUT_SCHEMA,
  FOREMAN_INPUT_BODY_SCHEMA,
  FOREMAN_PUBLIC_ORIGIN,
  FOREMAN_SERVICE_PATH,
  FOREMAN_SERVICE_RESOURCE,
  PaymentConfigurationError,
  readFacilitatorCredentials,
  serviceRouteConfiguration,
} from "../api/lib/payment.js";
import {
  createReviewerRelayServer,
  RELAY_HOST,
  RELAY_ROUTES,
  RELAY_UPSTREAM_TIMEOUT_MS,
  resolveRelayHost,
} from "./reviewer-relay.mjs";

const PAYER = "0x1111111111111111111111111111111111111111";
const TRANSACTION = `0x${"ab".repeat(32)}`;

function acceptedRequirements() {
  return {
    scheme: "exact",
    network: XLAYER.network,
    amount: PAYMENT.amount,
    asset: PAYMENT.asset.toLowerCase(),
    payTo: PAYMENT.payTo.toLowerCase(),
    maxTimeoutSeconds: 300,
    extra: {
      name: PAYMENT.name,
      version: PAYMENT.version,
      decimals: PAYMENT.decimals,
    },
  };
}

function paymentPayload() {
  return {
    x402Version: 2,
    resource: {
      url: FOREMAN_SERVICE_RESOURCE,
      mimeType: "application/json",
    },
    accepted: acceptedRequirements(),
    payload: {
      authorization: {
        from: PAYER,
        to: PAYMENT.payTo.toLowerCase(),
        value: PAYMENT.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"90".repeat(32)}`,
      },
      signature: `0x${"12".repeat(65)}`,
    },
  };
}

function paymentHeader(payload = paymentPayload()) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function trackedFacilitator({
  verifyValid = true,
  settleSuccess = true,
  expectedPayload = paymentPayload(),
} = {}) {
  const calls = { supported: 0, verify: 0, settle: 0 };
  return {
    calls,
    client: {
      async getSupported() {
        calls.supported += 1;
        return {
          kinds: [{ x402Version: 2, scheme: "exact", network: XLAYER.network }],
          extensions: [],
        };
      },
      async verify(payload, requirements) {
        calls.verify += 1;
        assert.deepEqual(payload, expectedPayload);
        assert.deepEqual(requirements, acceptedRequirements());
        if (!verifyValid) {
          return {
            isValid: false,
            invalidReason: "test_payment_invalid",
            invalidMessage: "Synthetic verification refusal",
          };
        }
        return { isValid: true, payer: PAYER };
      },
      async settle(_payload, requirements) {
        calls.settle += 1;
        assert.deepEqual(requirements, acceptedRequirements());
        if (!settleSuccess) {
          return {
            success: false,
            errorReason: "test_settlement_failure",
            errorMessage: "Synthetic settlement failure",
            transaction: "",
            network: XLAYER.network,
          };
        }
        return {
          success: true,
          status: "success",
          payer: PAYER,
          transaction: TRANSACTION,
          network: XLAYER.network,
        };
      },
    },
  };
}

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function requestWithHeaderBudget(url, {
  method = "POST",
  body,
  rawBody,
  headers = {},
  maxHeaderSize = 2_048,
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined
      ? rawBody
      : body === undefined
        ? null
        : JSON.stringify(body);
    const request = httpRequest(url, {
      method,
      maxHeaderSize,
      headers: {
        accept: "application/json",
        ...(payload === null ? {} : {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        }),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const headerText = response.rawHeaders.reduce(
          (value, entry, index) =>
            value + (index % 2 === 0 ? `${entry}: ` : `${entry}\r\n`),
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`,
        ) + "\r\n";
        resolve({
          status: response.statusCode,
          headers: response.headers,
          headerBytes: Buffer.byteLength(headerText),
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function rawHttpExchange(port, requestText) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.end(requestText);
    });
    socket.setTimeout(5_000, () => socket.destroy(new Error("raw HTTP probe timed out")));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

function decodeHeader(value) {
  assert.ok(value, "PAYMENT-REQUIRED must be present");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function realisticBody() {
  return {
    projectName: "AgentForge",
    summary: "Tests agent endpoints and listing behavior before marketplace launch.",
    targetUser: "OKX.AI service providers",
    liveUrl: "https://example.com/agentforge",
    notes: "Check whether the listed promise matches the delivered endpoint output.",
    deadline: "2026-09-01T00:00:00Z",
  };
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
const reviewerKeepWarmWorkflow = await readFile(
  new URL("../.github/workflows/reviewer-relay-keepwarm.yml", import.meta.url),
  "utf8",
);
assert.match(
  reviewerKeepWarmWorkflow,
  /https:\/\/okx-agent-review-relay\.onrender\.com\/conviction\/api\/health/,
  "the review-window keep-warm must cover Conviction through the canonical relay",
);
assert.equal(packageJson.dependencies["@okxweb3/x402-core"], "0.1.0");
assert.equal(packageJson.dependencies["@okxweb3/x402-evm"], "0.2.1");
assert.equal(packageJson.dependencies["@okxweb3/x402-express"], "0.1.1");
assert.equal(packageJson.dependencies["@x402/core"], undefined);
assert.equal(packageJson.dependencies["@x402/evm"], undefined);
assert.equal(packageJson.scripts.start, "npm run reviewer:relay");
assert.equal(resolveRelayHost(), "okx-agent-review-relay.onrender.com");
assert.equal(
  resolveRelayHost("okx-agent-review-relay-production.up.railway.app"),
  "okx-agent-review-relay-production.up.railway.app",
);
for (const invalidRelayHost of [
  "https://example.com",
  "EXAMPLE.com",
  "example.com/path",
  "example.com:443",
  "example..com",
  ".example.com",
  "example.com.",
]) {
  assert.throws(
    () => resolveRelayHost(invalidRelayHost),
    /lowercase DNS hostname/,
  );
}
assert.equal(FOREMAN_PUBLIC_ORIGIN, `https://${RELAY_HOST}`);
assert.equal(
  RELAY_UPSTREAM_TIMEOUT_MS,
  120_000,
  "the relay must not expire a valid slow settlement inside the 300-second payment window",
);
assert.doesNotMatch(
  FOREMAN_SERVICE_RESOURCE,
  /vercel/i,
  "the advertised payment resource must survive the marketplace deploy-tool guardrail",
);
assert.equal(
  FOREMAN_SERVICE_RESOURCE,
  `${FOREMAN_PUBLIC_ORIGIN}/foreman${FOREMAN_SERVICE_PATH}`,
);
assert.deepEqual(Object.keys(RELAY_ROUTES).sort(), [
  "/conviction/.well-known/x402",
  "/conviction/api/executor",
  "/conviction/api/health",
  "/conviction/api/manage",
  "/conviction/api/preview",
  "/conviction/api/quickstart",
  "/conviction/api/readiness",
  "/conviction/api/receipt",
  "/conviction/api/refresh",
  "/conviction/api/service",
  "/conviction/llms.txt",
  "/conviction/openapi.json",
  "/foreman/api/launch-readiness-pack",
  "/policypool/api/coverage-ledger",
  "/policypool/api/coverage-preflight",
  "/policypool/api/coverage-status",
  "/policypool/api/covered-job-receipt",
  "/policypool/api/provider-relay",
]);
assert.equal(
  RELAY_ROUTES["/conviction/api/executor"].upstream,
  "https://conviction-bay.vercel.app/api/executor?reviewerRelay=1",
);
assert.equal(
  RELAY_ROUTES["/conviction/api/refresh"].upstream,
  "https://conviction-bay.vercel.app/api/refresh?reviewerRelay=1",
);
assert.deepEqual(
  RELAY_ROUTES["/conviction/api/receipt"].queryKeys,
  ["proofType"],
);
assert.deepEqual(
  RELAY_ROUTES["/conviction/api/receipt"].queryValues.proofType,
  ["activation-terminal", "close", "recovery"],
);
assert.equal(
  RELAY_ROUTES["/policypool/api/covered-job-receipt"].queryPatterns.quote,
  "^ppq_[a-f0-9]{32}\\.[a-f0-9]{64}$",
);
assert.equal(
  RELAY_ROUTES["/policypool/api/coverage-status"].queryMaxLength,
  80,
);

const relayObservations = [];
const relayServer = createReviewerRelayServer({
  routes: {
    "/foreman/api/launch-readiness-pack": {
      agent: "foreman",
      upstream: "https://upstream.example.com/pinned-service?reviewerRelay=1",
    },
    "/conviction/api/refresh": {
      agent: "conviction",
      upstream: "https://upstream.example.com/api/refresh?reviewerRelay=1",
    },
  },
  fetchImpl: async (url, options) => {
    relayObservations.push({
      url: String(url),
      method: options.method,
      paymentSignature: options.headers.get("payment-signature"),
      authorization: options.headers.get("authorization"),
      cookie: options.headers.get("cookie"),
      forwardedHost: options.headers.get("x-forwarded-host"),
      forwardedProto: options.headers.get("x-forwarded-proto"),
      forwardedPrefix: options.headers.get("x-forwarded-prefix"),
      body: options.body?.toString("utf8") || "",
      redirect: options.redirect,
    });
    return new Response(JSON.stringify({ ok: false, error: "payment_required" }), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": "synthetic-challenge",
        "payment-response": "synthetic-settlement",
        "x-payment-response": "synthetic-legacy-settlement",
        "set-cookie": "must-not-leave-upstream",
      },
    });
  },
});
await new Promise((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = relayServer.address();
  const malformedTarget = await rawHttpExchange(
    port,
    "GET http://[ HTTP/1.1\r\nHost: reviewer-relay.local\r\nConnection: close\r\n\r\n",
  );
  assert.match(malformedTarget, /^HTTP\/1\.1 400 /);
  const healthAfterMalformedTarget = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/health`,
    { method: "GET" },
  );
  assert.equal(healthAfterMalformedTarget.status, 200);
  const relayed = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/foreman${FOREMAN_SERVICE_PATH}`,
    {
      body: realisticBody(),
      headers: {
        "payment-signature": "signed-payment-payload",
        authorization: "must-not-reach-upstream",
        cookie: "must-not-reach-upstream=1",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-prefix": "/attacker",
      },
    },
  );
  assert.equal(relayed.status, 402);
  assert.equal(relayed.headers["payment-required"], "synthetic-challenge");
  assert.equal(relayed.headers["payment-response"], "synthetic-settlement");
  assert.equal(
    relayed.headers["x-payment-response"],
    "synthetic-legacy-settlement",
  );
  assert.equal(relayed.headers["x-okx-review-relay"], "foreman-v1");
  assert.equal(relayed.headers["set-cookie"], undefined);
  assert.equal(relayObservations.length, 1);
  assert.deepEqual(relayObservations[0], {
    url: "https://upstream.example.com/pinned-service?reviewerRelay=1",
    method: "POST",
    paymentSignature: "signed-payment-payload",
    authorization: null,
    cookie: null,
    forwardedHost: RELAY_HOST,
    forwardedProto: "https",
    forwardedPrefix: "/foreman",
    body: JSON.stringify(realisticBody()),
    redirect: "error",
  });

  const refreshed = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/conviction/api/refresh`,
    {
      method: "POST",
      body: { paymentTx: "0xsettled", intentHash: "0xintent" },
      headers: {
        "payment-signature": "signed-refresh-payment",
        authorization: "must-not-reach-upstream",
        cookie: "must-not-reach-upstream=1",
      },
    },
  );
  assert.equal(refreshed.status, 402);
  assert.equal(relayObservations.length, 2);
  assert.deepEqual(relayObservations[1], {
    url: "https://upstream.example.com/api/refresh?reviewerRelay=1",
    method: "POST",
    paymentSignature: "signed-refresh-payment",
    authorization: null,
    cookie: null,
    forwardedHost: RELAY_HOST,
    forwardedProto: "https",
    forwardedPrefix: "/conviction",
    body: JSON.stringify({ paymentTx: "0xsettled", intentHash: "0xintent" }),
    redirect: "error",
  });

  const foremanHealth = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/foreman/health`,
    { method: "GET" },
  );
  assert.equal(foremanHealth.status, 200);
  assert.deepEqual(JSON.parse(foremanHealth.body), {
    ok: true,
    agent: "foreman",
    routes: ["/foreman/api/launch-readiness-pack"],
  });
  const isolatedHealth = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/policypool/health`,
    { method: "GET" },
  );
  assert.equal(isolatedHealth.status, 404);
  assert.equal(JSON.parse(isolatedHealth.body).error, "agent_not_found");
  const unlistedRoute = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/foreman/api/not-configured`,
    { method: "POST", body: realisticBody() },
  );
  assert.equal(unlistedRoute.status, 404);
  const callerQuery = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/foreman${FOREMAN_SERVICE_PATH}?reviewerRelay=0`,
    { method: "POST", body: realisticBody() },
  );
  assert.equal(callerQuery.status, 404);
  assert.equal(relayObservations.length, 2);
} finally {
  await new Promise((resolve) => relayServer.close(resolve));
}

const failureRelayServer = createReviewerRelayServer({
  routes: {
    "/conviction/api/refresh": {
      agent: "conviction",
      upstream: "https://upstream.example.com/api/refresh?reviewerRelay=1",
    },
  },
  fetchImpl: async () => {
    throw new Error("synthetic upstream timeout after forwarding");
  },
});
await new Promise((resolve) => failureRelayServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = failureRelayServer.address();
  const unpaidFailure = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/conviction/api/refresh`,
    { method: "POST", body: {} },
  );
  assert.equal(unpaidFailure.status, 502);
  assert.deepEqual(JSON.parse(unpaidFailure.body), {
    ok: false,
    error: "upstream_unavailable",
    charged: false,
  });
  const paidFailure = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/conviction/api/refresh`,
    {
      method: "POST",
      body: {},
      headers: { "payment-signature": "synthetic-paid-request" },
    },
  );
  assert.equal(paidFailure.status, 502);
  assert.deepEqual(JSON.parse(paidFailure.body), {
    ok: false,
    error: "upstream_settlement_ambiguous",
    cause: "upstream_unavailable",
    charged: null,
    settlement: "unknown",
    retryable: false,
    nextAction: "RECONCILE_PAYMENT_BEFORE_RETRY",
  });
} finally {
  await new Promise((resolve) => failureRelayServer.close(resolve));
}

const queryObservations = [];
const queryRelayServer = createReviewerRelayServer({
  routes: {
    "/policypool/api/coverage-status": {
      agent: "policypool",
      upstream: "https://upstream.example.com/api/coverage-status",
      queryKeys: ["receiptId", "id"],
      queryMaxLength: 80,
    },
    "/policypool/api/covered-job-receipt": {
      agent: "policypool",
      upstream: "https://upstream.example.com/api/covered-job-receipt",
      queryKeys: ["quote"],
      queryPatterns: {
        quote: "^ppq_[a-f0-9]{32}\\.[a-f0-9]{64}$",
      },
    },
    "/conviction/api/receipt": {
      agent: "conviction",
      upstream: "https://upstream.example.com/api/receipt",
      queryKeys: ["proofType"],
      queryValues: {
        proofType: ["activation-terminal", "close", "recovery"],
      },
      queryMaxLength: 19,
    },
  },
  fetchImpl: async (url) => {
    queryObservations.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
await new Promise((resolve) => queryRelayServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = queryRelayServer.address();
  const allowedQuery = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/policypool/api/coverage-status?receiptId=ppc-123`,
    { method: "GET" },
  );
  assert.equal(allowedQuery.status, 200);
  assert.deepEqual(queryObservations, [
    "https://upstream.example.com/api/coverage-status?receiptId=ppc-123",
  ]);
  const maximumStatusQuery = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/policypool/api/coverage-status?id=${"x".repeat(80)}`,
    { method: "GET" },
  );
  assert.equal(maximumStatusQuery.status, 200);
  assert.equal(
    queryObservations[1],
    `https://upstream.example.com/api/coverage-status?id=${"x".repeat(80)}`,
  );
  for (const unsafeQuery of [
    "next=https%3A%2F%2Fattacker.example",
    "receiptId=one&receiptId=two",
    `receiptId=${"x".repeat(81)}`,
  ]) {
    const rejectedQuery = await requestWithHeaderBudget(
      `http://127.0.0.1:${port}/policypool/api/coverage-status?${unsafeQuery}`,
      { method: "GET" },
    );
    assert.equal(rejectedQuery.status, 404);
  }
  assert.equal(queryObservations.length, 2);
  const allowedReceiptQuery = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/conviction/api/receipt?proofType=close`,
    { method: "POST", body: {} },
  );
  assert.equal(allowedReceiptQuery.status, 200);
  assert.equal(
    queryObservations[2],
    "https://upstream.example.com/api/receipt?proofType=close",
  );
  for (const unsafeReceiptQuery of [
    "proofType=unknown",
    "proofType=close&proofType=recovery",
    "proofType=close&next=attacker",
  ]) {
    const rejectedReceiptQuery = await requestWithHeaderBudget(
      `http://127.0.0.1:${port}/conviction/api/receipt?${unsafeReceiptQuery}`,
      { method: "POST", body: {} },
    );
    assert.equal(rejectedReceiptQuery.status, 404);
  }
  assert.equal(queryObservations.length, 3);
  const signedQuote = `ppq_${"a".repeat(32)}.${"b".repeat(64)}`;
  const allowedQuote = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/policypool/api/covered-job-receipt?quote=${signedQuote}`,
    { method: "POST", body: {} },
  );
  assert.equal(allowedQuote.status, 200);
  assert.equal(
    queryObservations[3],
    `https://upstream.example.com/api/covered-job-receipt?quote=${signedQuote}`,
  );
  for (const unsafeQuoteQuery of [
    "quote=",
    `quote=${signedQuote.toUpperCase()}`,
    `quote=ppq_${"a".repeat(31)}.${"b".repeat(64)}`,
    `quote=${signedQuote}&quote=${signedQuote}`,
    `quote=${signedQuote}&next=attacker`,
    `token=${signedQuote}`,
  ]) {
    const rejectedQuote = await requestWithHeaderBudget(
      `http://127.0.0.1:${port}/policypool/api/covered-job-receipt?${unsafeQuoteQuery}`,
      { method: "POST", body: {} },
    );
    assert.equal(rejectedQuote.status, 404);
  }
  assert.equal(queryObservations.length, 4);
  const policyPoolHealth = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/policypool/healthz`,
    { method: "GET" },
  );
  assert.equal(policyPoolHealth.status, 200);
  assert.deepEqual(JSON.parse(policyPoolHealth.body), {
    ok: true,
    agent: "policypool",
    routes: [
      "/policypool/api/coverage-status",
      "/policypool/api/covered-job-receipt",
    ],
  });
} finally {
  await new Promise((resolve) => queryRelayServer.close(resolve));
}

const blockedHeader = Buffer.from(JSON.stringify({
  resource: { url: "https://blocked-example.vercel.app/api/service" },
})).toString("base64");
const leakRelayServer = createReviewerRelayServer({
  routes: {
    "/foreman/api/header-leak": {
      agent: "foreman",
      upstream: "https://upstream.example.com/api/header-leak",
    },
    "/foreman/api/body-leak": {
      agent: "foreman",
      upstream: "https://upstream.example.com/api/body-leak",
    },
    "/foreman/api/large-response": {
      agent: "foreman",
      upstream: "https://upstream.example.com/api/large-response",
    },
    "/foreman/api/json-escaped-leak": {
      agent: "foreman",
      upstream: "https://upstream.example.com/api/json-escaped-leak",
    },
    "/foreman/api/paid-content": {
      agent: "foreman",
      upstream: "https://upstream.example.com/api/paid-content",
    },
  },
  fetchImpl: async (url) => {
    if (String(url).endsWith("header-leak")) {
      return new Response(JSON.stringify({ ok: false }), {
        status: 402,
        headers: { "payment-required": blockedHeader },
      });
    }
    if (String(url).endsWith("large-response")) {
      return new Response(Buffer.alloc(1024 * 1024 + 1, "a"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (String(url).endsWith("json-escaped-leak")) {
      return new Response('{"url":"https://blocked-example.ver\\u0063el.app"}', {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).endsWith("paid-content")) {
      return new Response(JSON.stringify({
        ok: true,
        summary: "The buyer asked us to review a deployment on vercel.",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "payment-response": "synthetic-paid-settlement",
        },
      });
    }
    return new Response(JSON.stringify({ url: "https://blocked-example.vercel.app" }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  },
});
await new Promise((resolve) => leakRelayServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = leakRelayServer.address();
  for (const path of ["header-leak", "body-leak", "json-escaped-leak"]) {
    const blocked = await requestWithHeaderBudget(
      `http://127.0.0.1:${port}/foreman/api/${path}`,
      { method: "POST", body: {} },
    );
    assert.equal(blocked.status, 502);
    assert.equal(blocked.headers["payment-required"], undefined);
    assert.doesNotMatch(blocked.body, /vercel/i);
    assert.equal(JSON.parse(blocked.body).error, "upstream_response_not_reviewer_safe");
  }
  const oversized = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/foreman/api/large-response`,
    { method: "GET" },
  );
  assert.equal(oversized.status, 502);
  assert.equal(JSON.parse(oversized.body).error, "upstream_response_too_large");
  const paidContent = await requestWithHeaderBudget(
    `http://127.0.0.1:${port}/foreman/api/paid-content`,
    {
      method: "POST",
      body: { projectName: "Vercel migration review" },
      headers: { "payment-signature": "synthetic-paid-request" },
    },
  );
  assert.equal(paidContent.status, 200);
  assert.equal(paidContent.headers["payment-response"], "synthetic-paid-settlement");
  assert.match(JSON.parse(paidContent.body).summary, /vercel/i);
} finally {
  await new Promise((resolve) => leakRelayServer.close(resolve));
}

assert.deepEqual(
  readFacilitatorCredentials({
    OKX_API_KEY: "api-key",
    OKX_SECRET_KEY: "secret-key",
    OKX_PASSPHRASE: "passphrase",
  }),
  {
    apiKey: "api-key",
    secretKey: "secret-key",
    passphrase: "passphrase",
    syncSettle: true,
  },
);
for (const environment of [
  {},
  { OKX_API_KEY: " api-key ", OKX_SECRET_KEY: "secret-key", OKX_PASSPHRASE: "passphrase" },
]) {
  assert.throws(
    () => readFacilitatorCredentials(environment),
    (error) => error instanceof PaymentConfigurationError,
  );
}

const route = serviceRouteConfiguration()[`* ${FOREMAN_SERVICE_PATH}`];
assert.equal(route.resource, FOREMAN_SERVICE_RESOURCE);
assert.equal(route.accepts.scheme, "exact");
assert.equal(route.accepts.network, XLAYER.network);
assert.equal(route.accepts.price.amount, PAYMENT.amount);
assert.equal(route.accepts.price.asset, PAYMENT.asset.toLowerCase());
assert.equal(route.accepts.payTo, PAYMENT.payTo.toLowerCase());
assert.deepEqual(route.extensions.outputSchema, FOREMAN_CHALLENGE_OUTPUT_SCHEMA);

const unpaidFacilitator = trackedFacilitator();
const unpaidApp = createHandler({
  facilitatorClient: unpaidFacilitator.client,
  controlledFailureConfig: null,
  logger: { error() {} },
});

let maximumUnpaidHeaderBytes = 0;
await withServer(unpaidApp, async (origin) => {
  const probes = [
    { label: "GET", options: { method: "GET" } },
    { label: "HEAD", options: { method: "HEAD" } },
    { label: "POST empty", options: { method: "POST", body: {} } },
    { label: "POST unknown", options: { method: "POST", body: { zzz: 1 } } },
    { label: "POST realistic", options: { method: "POST", body: realisticBody() } },
  ];
  for (const probe of probes) {
    const response = await requestWithHeaderBudget(
      `${origin}${FOREMAN_SERVICE_PATH}`,
      probe.options,
    );
    maximumUnpaidHeaderBytes = Math.max(
      maximumUnpaidHeaderBytes,
      response.headerBytes,
    );
    assert.equal(response.status, 402, probe.label);
    assert.ok(response.headerBytes < 2_048, `${probe.label} headers must fit inside 2 KiB`);
    const challenge = decodeHeader(response.headers["payment-required"]);
    assert.equal(challenge.x402Version, 2);
    assert.deepEqual(challenge.outputSchema, FOREMAN_CHALLENGE_OUTPUT_SCHEMA);
    assert.deepEqual(
      challenge.outputSchema.input.body.required,
      ["projectName", "summary"],
      "the compact header must describe a request the paid handler can deliver",
    );
    assert.equal(
      Object.hasOwn(challenge.outputSchema.input.body.properties, "deadline"),
      false,
      "the header must carry only the compact discovery schema",
    );
    assert.equal(Object.hasOwn(challenge.extensions ?? {}, "outputSchema"), false);
    assert.equal(challenge.accepts.length, 1);
    assert.equal(challenge.accepts[0].network, XLAYER.network);
    assert.equal(challenge.accepts[0].amount, PAYMENT.amount);
    for (const nonStandard of ["maxAmountRequired", "decimals", "symbol"]) {
      assert.equal(Object.hasOwn(challenge.accepts[0], nonStandard), false);
    }
    if (probe.label !== "HEAD") {
      const body = JSON.parse(response.body);
      assert.equal(body.error.code, "payment_required");
      assert.match(body.error.message, /accepts\[0\]/);
      assert.doesNotMatch(body.error.message, /0\.1 USD/);
      assert.deepEqual(body.inputSchema, FOREMAN_INPUT_BODY_SCHEMA);
      assert.ok(body.inputSchema.anyOf.length > 0);
      assert.equal(body.inputSchema.properties.deadline.type, "string");
      assert.deepEqual(body.outputSchema.input.body, FOREMAN_INPUT_BODY_SCHEMA);
      assert.equal(body.usageExamples[0].projectName, "AgentForge");
      assert.equal(body.charged, false);
    }
  }
  const options = await requestWithHeaderBudget(`${origin}${FOREMAN_SERVICE_PATH}`, {
    method: "OPTIONS",
  });
  assert.equal(options.status, 204);
});
assert.ok(
  maximumUnpaidHeaderBytes < 1_800,
  `unpaid headers need deployment headroom; measured ${maximumUnpaidHeaderBytes} bytes`,
);
console.log(`Foreman strict-client header budget: ${maximumUnpaidHeaderBytes} bytes`);
assert.equal(unpaidFacilitator.calls.supported, 1);
assert.equal(unpaidFacilitator.calls.verify, 0);
assert.equal(unpaidFacilitator.calls.settle, 0);

const paidFacilitator = trackedFacilitator();
const paidApp = createHandler({
  facilitatorClient: paidFacilitator.client,
  controlledFailureConfig: null,
  logger: { error() {} },
});
await withServer(paidApp, async (origin) => {
  const invalid = await requestWithHeaderBudget(`${origin}${FOREMAN_SERVICE_PATH}`, {
    body: {},
    headers: { "payment-signature": paymentHeader() },
  });
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.body).charged, false);
  assert.equal(paidFacilitator.calls.verify, 1);
  assert.equal(paidFacilitator.calls.settle, 0);

  const paid = await requestWithHeaderBudget(`${origin}${FOREMAN_SERVICE_PATH}`, {
    body: realisticBody(),
    headers: { "payment-signature": paymentHeader() },
  });
  assert.equal(paid.status, 200);
  assert.ok(paid.headers["payment-response"]);
  const delivered = JSON.parse(paid.body);
  assert.equal(delivered.ok, true);
  assert.equal(delivered.agent, "Foreman");
  assert.equal(delivered.input.projectName, "AgentForge");
  assert.equal(delivered.servicePayment.settled, true);
  assert.equal(delivered.servicePayment.proofHeader, "PAYMENT-RESPONSE");
});
assert.equal(paidFacilitator.calls.supported, 1);
assert.equal(paidFacilitator.calls.verify, 2);
assert.equal(paidFacilitator.calls.settle, 1);

const verifyFailure = trackedFacilitator({ verifyValid: false });
await withServer(createHandler({
  facilitatorClient: verifyFailure.client,
  controlledFailureConfig: null,
  logger: { error() {} },
}), async (origin) => {
  const response = await requestWithHeaderBudget(`${origin}${FOREMAN_SERVICE_PATH}`, {
    body: realisticBody(),
    headers: { "payment-signature": paymentHeader() },
  });
  assert.equal(response.status, 402);
  assert.equal(verifyFailure.calls.settle, 0);
});

const settlementFailure = trackedFacilitator({ settleSuccess: false });
await withServer(createHandler({
  facilitatorClient: settlementFailure.client,
  controlledFailureConfig: null,
  logger: { error() {} },
}), async (origin) => {
  const response = await requestWithHeaderBudget(`${origin}${FOREMAN_SERVICE_PATH}`, {
    body: realisticBody(),
    headers: { "payment-signature": paymentHeader() },
  });
  assert.equal(response.status, 402);
  assert.equal(JSON.parse(response.body).error.code, "payment_settlement_failed");
  assert.doesNotMatch(response.body, /demoShotlist90s/);
});
assert.equal(settlementFailure.calls.settle, 1);

const authorization = "controlled-test-authorization";
const pilotFacilitator = trackedFacilitator();
const pilotConfig = {
  id: "controlled-pilot",
  authorizationHash: createHash("sha256").update(authorization).digest("hex"),
  payer: PAYER,
  expiresAt: Date.now() + 60_000,
};
await withServer(createHandler({
  facilitatorClient: pilotFacilitator.client,
  controlledFailureConfig: pilotConfig,
  logger: { error() {} },
}), async (origin) => {
  const response = await requestWithHeaderBudget(`${origin}${FOREMAN_SERVICE_PATH}`, {
    body: {
      ...realisticBody(),
      controlledProviderFailure: { id: pilotConfig.id, authorization },
    },
    headers: { "payment-signature": paymentHeader() },
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers["payment-response"]);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.equal(body.status, "controlled_provider_non_delivery");
  assert.equal(body.charged, true);
  assert.doesNotMatch(response.body, new RegExp(authorization));
});
assert.equal(pilotFacilitator.calls.verify, 1);
assert.equal(pilotFacilitator.calls.settle, 1);

async function assertControlledFailureRejected({
  label,
  controlledFailureConfig,
  marker,
  expectedError,
}) {
  const facilitator = trackedFacilitator();
  await withServer(createHandler({
    facilitatorClient: facilitator.client,
    controlledFailureConfig,
    logger: { error() {} },
  }), async (origin) => {
    const response = await requestWithHeaderBudget(`${origin}${FOREMAN_SERVICE_PATH}`, {
      body: {
        ...realisticBody(),
        controlledProviderFailure: marker,
      },
      headers: { "payment-signature": paymentHeader() },
    });
    assert.equal(response.status, 403, label);
    const body = JSON.parse(response.body);
    assert.equal(body.error, expectedError, label);
    assert.equal(body.charged, false, label);
    assert.equal(response.headers["payment-response"], undefined, label);
  });
  assert.equal(facilitator.calls.verify, 1, label);
  assert.equal(facilitator.calls.settle, 0, label);
}

await assertControlledFailureRejected({
  label: "malformed controlled-failure marker",
  controlledFailureConfig: pilotConfig,
  marker: "not-an-object",
  expectedError: "controlled_failure_request_invalid",
});

await assertControlledFailureRejected({
  label: "disabled controlled-failure pilot",
  controlledFailureConfig: null,
  marker: { id: pilotConfig.id, authorization },
  expectedError: "controlled_failure_disabled",
});

await assertControlledFailureRejected({
  label: "invalid controlled-failure authorization",
  controlledFailureConfig: pilotConfig,
  marker: { id: pilotConfig.id, authorization: "wrong-authorization" },
  expectedError: "controlled_failure_authorization_invalid",
});

await assertControlledFailureRejected({
  label: "controlled-failure payer mismatch",
  controlledFailureConfig: {
    ...pilotConfig,
    payer: "0x2222222222222222222222222222222222222222",
  },
  marker: { id: pilotConfig.id, authorization },
  expectedError: "controlled_failure_payer_mismatch",
});

// The facilitator may accept a syntactically valid payment that does not match
// Foreman's pinned service. The post-verification capture must still reject it
// before the official middleware can settle or expose the deliverable.
const mismatchedPayment = paymentPayload();
mismatchedPayment.payload = {
  ...mismatchedPayment.payload,
  authorization: {
    ...mismatchedPayment.payload.authorization,
    value: "100001",
  },
};
const captureMismatchFacilitator = trackedFacilitator({
  expectedPayload: mismatchedPayment,
});
await withServer(createHandler({
  facilitatorClient: captureMismatchFacilitator.client,
  controlledFailureConfig: pilotConfig,
  logger: { error() {} },
}), async (origin) => {
  const response = await requestWithHeaderBudget(`${origin}${FOREMAN_SERVICE_PATH}`, {
    body: {
      ...realisticBody(),
      controlledProviderFailure: { id: pilotConfig.id, authorization },
    },
    headers: { "payment-signature": paymentHeader(mismatchedPayment) },
  });
  assert.equal(response.status, 422);
  const body = JSON.parse(response.body);
  assert.equal(body.error, "payment_authorization_mismatch");
  assert.equal(body.charged, false);
  assert.equal(response.headers["payment-response"], undefined);
});
assert.equal(captureMismatchFacilitator.calls.verify, 1);
assert.equal(captureMismatchFacilitator.calls.settle, 0);

console.log(
  "Foreman API gate passed: official OKX SDK, discoverable 402 contract, strict 2 KiB headers, no-charge validation, and settlement withholding verified.",
);
