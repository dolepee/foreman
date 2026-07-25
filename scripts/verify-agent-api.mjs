import assert from "node:assert/strict";
import { createHandler } from "../api/launch-readiness-pack.js";

function callHandler(handler, { method = "GET", headers = {}, body, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const responseHeaders = {};
    const req = { method, headers, body, query, url: "/api/launch-readiness-pack" };
    const res = {
      statusCode: 200,
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
      status(code) { this.statusCode = code; return this; },
      send(payload) {
        resolve({
          statusCode: this.statusCode,
          headers: responseHeaders,
          json: () => JSON.parse(payload),
        });
      },
      end() { resolve({ statusCode: this.statusCode, headers: responseHeaders }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const calls = { verify: 0, settle: 0 };
const payment = {
  async verify(raw) {
    calls.verify += 1;
    if (raw === "malformed") {
      const error = new Error("payment_signature_malformed");
      error.code = "payment_signature_malformed";
      throw error;
    }
    return { payer: "0x1111111111111111111111111111111111111111", payload: {} };
  },
  async settle(_verified, requirements) {
    calls.settle += 1;
    return {
      success: true,
      network: requirements.network,
      transaction: `0x${"1".repeat(64)}`,
      payer: "0x1111111111111111111111111111111111111111",
      amount: requirements.amount,
      responseHeader: "settled-response",
      transfer: {
        txHash: `0x${"1".repeat(64)}`,
        from: "0x1111111111111111111111111111111111111111",
        to: requirements.payTo,
        amountAtomic: requirements.amount,
      },
    };
  },
};
const handler = createHandler({ payment });

const head = await callHandler(handler, { method: "HEAD" });
assert.equal(head.statusCode, 200);

const unpaid = await callHandler(handler, { method: "GET" });
assert.equal(unpaid.statusCode, 402);
const challenge = JSON.parse(Buffer.from(unpaid.headers["payment-required"], "base64").toString());
assert.equal(challenge.x402Version, 2);
assert.equal(challenge.accepts[0].amount, "100000");
assert.equal(challenge.accepts[0].maxAmountRequired, "100000");
assert.equal(challenge.accepts[0].extra.name, "USD₮0");
assert.equal(challenge.accepts[0].extra.version, "1");

const fakeAuthorization = await callHandler(handler, {
  method: "POST",
  headers: { authorization: "Bearer not-a-payment" },
  body: { projectName: "AgentForge", summary: "Builds and validates agent services before launch." },
});
assert.equal(fakeAuthorization.statusCode, 402);
assert.equal(calls.verify, 0);
assert.equal(calls.settle, 0);

const insufficient = await callHandler(handler, {
  method: "POST",
  headers: { "payment-signature": "valid-test-payment" },
  body: {},
});
assert.equal(insufficient.statusCode, 400);
assert.equal(insufficient.json().error, "insufficient_project_context");
assert.equal(insufficient.json().charged, false);
assert.equal(calls.verify, 0);
assert.equal(calls.settle, 0);

const paid = await callHandler(handler, {
  method: "POST",
  headers: { "payment-signature": "valid-test-payment" },
  body: {
    input: {
      agentName: "AgentForge",
      whatItDoes: "Tests agent endpoints and listing behavior before marketplace launch.",
      whoIsItFor: "OKX.AI service providers",
      liveListing: "https://www.okx.ai/agents/3746",
      secondOpinion: "Check whether the listed promise matches the delivered endpoint output.",
      submissionDeadline: "2026-07-17T00:00:00Z",
    },
  },
});
assert.equal(paid.statusCode, 200);
const paidPayload = paid.json();
assert.equal(paidPayload.servicePayment.settled, true);
assert.equal(paidPayload.servicePayment.amountAtomic, "100000");
assert.equal(paidPayload.input.projectName, "AgentForge");
assert.equal(paidPayload.input.targetUser, "OKX.AI service providers");
assert.match(paidPayload.result.demoShotlist90s.join(" "), /AgentForge/);
assert.match(paidPayload.result.xPostDraft, /AgentForge/);
assert.match(JSON.stringify(paidPayload.result.listingCheck.findings), /listed promise matches/);
assert.deepEqual(
  paidPayload.result.personalization.fieldsUsed.sort(),
  ["deadline", "liveUrl", "notes", "projectName", "summary", "targetUser"].sort(),
);
assert.equal(calls.verify, 1);
assert.equal(calls.settle, 1);

const previousPartialPilotId = process.env.FOREMAN_CONTROLLED_FAILURE_ID;
process.env.FOREMAN_CONTROLLED_FAILURE_ID = "partial-config-must-not-affect-normal-buyers";
const normalWithMalformedPilotConfig = await callHandler(createHandler({ payment }), {
  method: "POST",
  headers: { "payment-signature": "valid-test-payment" },
  body: {
    projectName: "Normal buyer",
    summary: "This ordinary request must remain isolated from optional pilot configuration.",
  },
});
if (previousPartialPilotId === undefined) delete process.env.FOREMAN_CONTROLLED_FAILURE_ID;
else process.env.FOREMAN_CONTROLLED_FAILURE_ID = previousPartialPilotId;
assert.equal(normalWithMalformedPilotConfig.statusCode, 200);
assert.equal(normalWithMalformedPilotConfig.json().ok, true);
assert.equal(calls.verify, 2);
assert.equal(calls.settle, 2);

const pilotConfig = {
  id: "pp-keji-001",
  authorizationHash: "e1c857df4dfc2e65719d9bf19750898c8a11143e3b3f31085e8e3d584d379268",
  payer: "0x1111111111111111111111111111111111111111",
  expiresAt: Date.now() + 60_000,
};
const pilotHandler = createHandler({ payment, controlledFailureConfig: pilotConfig });

const unauthorizedPilot = await callHandler(pilotHandler, {
  method: "POST",
  headers: { "payment-signature": "valid-test-payment" },
  body: {
    projectName: "PolicyPool pilot",
    summary: "Controlled provider non-delivery with an independent buyer.",
    controlledProviderFailure: { id: pilotConfig.id, authorization: "wrong" },
  },
});
assert.equal(unauthorizedPilot.statusCode, 403);
assert.equal(unauthorizedPilot.json().charged, false);
assert.equal(calls.verify, 2);
assert.equal(calls.settle, 2);

const controlledFailure = await callHandler(pilotHandler, {
  method: "POST",
  headers: { "payment-signature": "valid-test-payment" },
  body: {
    input: {
      projectName: "PolicyPool pilot",
      summary: "Controlled provider non-delivery with an independent buyer.",
      controlledProviderFailure: { id: pilotConfig.id, authorization: "test-authorization" },
    },
  },
});
assert.equal(controlledFailure.statusCode, 409);
assert.equal(controlledFailure.headers["payment-response"], "settled-response");
assert.equal(controlledFailure.json().error, "controlled_provider_non_delivery");
assert.equal(controlledFailure.json().charged, true);
assert.equal(controlledFailure.json().pilot.deliverableWithheld, true);
assert.equal(calls.verify, 3);
assert.equal(calls.settle, 3);
assert.doesNotMatch(JSON.stringify(controlledFailure.json()), /test-authorization/);

const disabledPilot = await callHandler(createHandler({ payment, controlledFailureConfig: null }), {
  method: "POST",
  headers: { "payment-signature": "valid-test-payment" },
  body: {
    projectName: "PolicyPool pilot",
    summary: "Controlled provider non-delivery with an independent buyer.",
    controlledProviderFailure: { id: pilotConfig.id, authorization: "test-authorization" },
  },
});
assert.equal(disabledPilot.statusCode, 403);
assert.equal(disabledPilot.json().error, "controlled_failure_disabled");
assert.equal(disabledPilot.json().charged, false);
assert.equal(calls.verify, 3);
assert.equal(calls.settle, 3);

const wrongPayerPayment = {
  ...payment,
  async verify() {
    return { payer: "0x2222222222222222222222222222222222222222", payload: {} };
  },
};
const wrongPayerPilot = await callHandler(
  createHandler({ payment: wrongPayerPayment, controlledFailureConfig: pilotConfig }),
  {
    method: "POST",
    headers: { "payment-signature": "valid-test-payment" },
    body: {
      projectName: "PolicyPool pilot",
      summary: "Controlled provider non-delivery with an independent buyer.",
      controlledProviderFailure: { id: pilotConfig.id, authorization: "test-authorization" },
    },
  },
);
assert.equal(wrongPayerPilot.statusCode, 403);
assert.equal(wrongPayerPilot.json().error, "controlled_failure_payer_mismatch");
assert.equal(wrongPayerPilot.json().charged, false);
assert.equal(calls.settle, 3);

console.log("Foreman API gate passed: validated input before charge, personalized nested fields, verified settlement, and transfer receipt.");
