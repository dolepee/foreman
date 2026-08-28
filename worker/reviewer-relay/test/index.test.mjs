import assert from "node:assert/strict";
import test from "node:test";

import { createRelayHandler, RELAY_ROUTES } from "../src/relay.ts";
import { RELAY_ROUTES as NODE_RELAY_ROUTES } from "../../../scripts/reviewer-relay.mjs";

const json = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init,
  headers: { "content-type": "application/json", ...(init.headers || {}) },
});

test("Worker route inventory stays identical to the reviewed Node relay", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(RELAY_ROUTES)), JSON.parse(JSON.stringify(NODE_RELAY_ROUTES)));
});

test("health is local and identifies the Workers runtime", async () => {
  const relay = createRelayHandler(async () => { throw new Error("fetch must not run"); });
  const response = await relay(new Request("https://relay.example/health"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).agents, ["foreman", "policypool", "conviction"]);
  assert.equal(response.headers.has("x-request-id"), true);
});

test("pinned routes preserve method, body, payment header, query and public host", async () => {
  let observed;
  const relay = createRelayHandler(async (url, init) => {
    observed = { url: String(url), init };
    return json({ ok: true }, { status: 200, headers: { "payment-response": "paid" } });
  });
  const response = await relay(new Request(
    "https://okx-agent-review-relay.example/policypool/api/covered-job-receipt?quote=ppq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    { method: "POST", headers: { "content-type": "application/json", "payment-signature": "proof" }, body: "{\"job\":1}" },
  ));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("payment-response"), "paid");
  assert.equal(response.headers.get("x-okx-review-relay"), "policypool-v2");
  assert.match(observed.url, /quote=ppq_/);
  assert.equal(observed.init.headers.get("x-forwarded-host"), "okx-agent-review-relay.example");
  assert.equal(observed.init.headers.get("payment-signature"), "proof");
  assert.equal(new TextDecoder().decode(observed.init.body), "{\"job\":1}");
});

test("unknown routes, invalid queries and methods fail closed", async () => {
  const relay = createRelayHandler(async () => json({ ok: true }));
  assert.equal((await relay(new Request("https://relay.example/missing"))).status, 404);
  assert.equal((await relay(new Request("https://relay.example/policypool/api/coverage-status?other=x"))).status, 404);
  const method = await relay(new Request("https://relay.example/conviction/api/health", { method: "PUT" }));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
});

test("oversized requests are rejected before upstream execution", async () => {
  let calls = 0;
  const relay = createRelayHandler(async () => { calls += 1; return json({ ok: true }); });
  const response = await relay(new Request("https://relay.example/conviction/api/manage", {
    method: "POST",
    body: new Uint8Array(64 * 1024 + 1),
  }));
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test("upstream identity leakage fails closed and paid ambiguity forbids retry", async () => {
  const relay = createRelayHandler(async () => json({ resource: "https://private.vercel.app/api" }, { status: 402 }));
  const unpaid = await relay(new Request("https://relay.example/foreman/api/launch-readiness-pack", { method: "POST", body: "{}" }));
  assert.equal(unpaid.status, 502);
  assert.equal((await unpaid.json()).charged, false);
  const paid = await relay(new Request("https://relay.example/foreman/api/launch-readiness-pack", {
    method: "POST",
    headers: { "payment-signature": "proof" },
    body: "{}",
  }));
  const paidBody = await paid.json();
  assert.equal(paidBody.error, "upstream_settlement_ambiguous");
  assert.equal(paidBody.retryable, false);
});

test("upstream redirects never escape the pinned relay", async () => {
  const relay = createRelayHandler(async () => new Response(null, {
    status: 302,
    headers: { location: "https://untrusted.example/redirect" },
  }));
  const response = await relay(new Request("https://relay.example/conviction/api/health"));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "upstream_unavailable");
});
