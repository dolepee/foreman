import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";

import { createHandler } from "../api/launch-readiness-pack.js";
import { PAYMENT, XLAYER } from "../api/lib/config.js";
import {
  FOREMAN_CHALLENGE_OUTPUT_SCHEMA,
  FOREMAN_INPUT_BODY_SCHEMA,
  FOREMAN_SERVICE_PATH,
  FOREMAN_SERVICE_RESOURCE,
  PaymentConfigurationError,
  readFacilitatorCredentials,
  serviceRouteConfiguration,
} from "../api/lib/payment.js";

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
assert.equal(packageJson.dependencies["@okxweb3/x402-core"], "0.1.0");
assert.equal(packageJson.dependencies["@okxweb3/x402-evm"], "0.2.1");
assert.equal(packageJson.dependencies["@okxweb3/x402-express"], "0.1.1");
assert.equal(packageJson.dependencies["@x402/core"], undefined);
assert.equal(packageJson.dependencies["@x402/evm"], undefined);

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
