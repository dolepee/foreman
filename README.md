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
npm run agent:verify
npm run build
npm run lint
npm run order:validate
npm run sample:all
```

`sample:all` validates the sample order, generates a 90-second demo shotlist, creates a Launch Readiness Pack, verifies its hashes and receipt, and builds the public service page.

## Current Status

This repo is in 24-hour validation-spike mode. The OKX.AI A2A listing, paid order receipts, customer reviews, funded warranty reserve, and any subcontracted ASP payment must be added only after they are real.
