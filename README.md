# Foreman

Foreman is the OKX.AI launch contractor for agent builders.

Give Foreman raw launch material. It returns one submission-ready Launch Readiness Pack: a structured listing check, a 90-second demo shotlist, an announcement post draft, and a delivery receipt backed by a refund warranty.

## Scope

Foreman's listed service is `Launch Readiness Pack` at `0.1 USD₮0` on X Layer. It includes:

- A launch-readiness check with the highest-priority listing and buyer-flow issues.
- A 90-second demo shotlist.
- An announcement-post draft.
- A delivery receipt with the checked inputs and output hash.

Foreman will not provide trading advice, fake reviews, engagement farming, regulated advice, or promises about hackathon results.

## Warranty

If the delivered asset misses the written scope and we cannot fix it within the revision window, we refund the service fee.

The warranty reserve address is added only after it is actually funded.

## Validation Commands

```bash
npm run typecheck
npm run test
npm run gate
npm run agent:verify
npm run build
npm run lint
npm run order:validate
npm run sample:all
```

`sample:all` validates the sample order, generates a 90-second demo shotlist, creates a Launch Readiness Pack, verifies its hashes and receipt, and builds the public service page.

## Payment Integration

The fixed-price A2MCP endpoint uses the official OKX seller SDK packages (`@okxweb3/x402-core`, `@okxweb3/x402-evm`, and `@okxweb3/x402-express`). Production requires `OKX_API_KEY`, `OKX_SECRET_KEY`, and `OKX_PASSPHRASE`; their values must never be committed or logged.

An unpaid request receives a compact `402` challenge with a machine-readable input schema and a concrete example. The detailed request is validated after payment verification but before settlement, so incomplete paid replays are rejected without charging. A successful response is released only after settlement and carries the canonical `PAYMENT-RESPONSE` proof header.

The marketplace-facing resource is `https://okx-agent-review-relay.onrender.com/foreman/api/launch-readiness-pack`. This fixed-route, no-secret relay preserves the request method, body, payment challenge, payment proof, and settlement response while routing to the same production service. It forwards neither caller authorization nor cookies and cannot be pointed at an arbitrary upstream. A scheduled no-secret health probe keeps the free ingress responsive during the review window. Foreman does not attempt an on-chain or chat deliverable fallback for A2MCP jobs: the official payment-mode-3 lifecycle defines the paid endpoint replay as the delivery and forbids a second `deliver` action.

## Current Status

Foreman is an OKX.AI A2MCP service. Marketplace listing state, paid receipts, customer reviews, warranty funding, and subcontracted payments are claimed only when independently observable.
