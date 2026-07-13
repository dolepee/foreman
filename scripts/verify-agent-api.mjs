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

const unpaid = await callHandler(handler, { method: "POST", body: {} });
assert.equal(unpaid.statusCode, 402);
const challenge = JSON.parse(Buffer.from(unpaid.headers["payment-required"], "base64").toString());
assert.equal(challenge.x402Version, 2);
assert.equal(challenge.accepts[0].amount, "500000");
assert.equal(challenge.accepts[0].maxAmountRequired, "500000");
assert.equal(challenge.accepts[0].extra.name, "USD₮0");
assert.equal(challenge.accepts[0].extra.version, "1");

const fakeAuthorization = await callHandler(handler, {
  method: "POST",
  headers: { authorization: "Bearer not-a-payment" },
  body: {},
});
assert.equal(fakeAuthorization.statusCode, 402);
assert.equal(calls.verify, 0);
assert.equal(calls.settle, 0);

const paid = await callHandler(handler, {
  method: "POST",
  headers: { "payment-signature": "valid-test-payment" },
  body: { projectName: "Foreman payment truth test", liveUrl: "https://example.com" },
});
assert.equal(paid.statusCode, 200);
assert.equal(paid.json().servicePayment.settled, true);
assert.equal(paid.json().servicePayment.amountAtomic, "500000");
assert.equal(calls.verify, 1);
assert.equal(calls.settle, 1);

console.log("Foreman API gate passed: 0.5 USDT challenge, fake-header rejection, verified settlement, and transfer receipt.");
