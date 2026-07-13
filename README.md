# Foreman

Foreman is the OKX.AI launch contractor for agent builders.

Give Foreman raw launch material. It returns a submission-ready package: a captioned 90-second demo cut, an OKX.AI listing audit, an announcement post draft, and a delivery receipt backed by a refund warranty.

## Scope

Foreman has three SKUs only:

- `Demo Cut`: raw clips become a captioned 90-second demo, vertical and horizontal, plus a thumbnail.
- `Listing Audit`: service page and flow stress test with review-blocking issues and a fix list.
- `Launch Pack`: Demo Cut plus Listing Audit plus announcement post draft and proof pack.

Foreman will not provide trading advice, fake reviews, engagement farming, regulated advice, or promises about hackathon results.

## Warranty

If the delivered asset misses the written scope and we cannot fix it within the revision window, we refund the service fee.

The warranty reserve address is added only after it is actually funded.

## Validation Commands

One-time local render setup:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

```bash
npm run typecheck
npm run build
npm run lint
npm run ffmpeg:check
npm run order:validate
npm run sample:all
```

`sample:all` validates the sample order, generates a shot list, renders sample horizontal and vertical videos with `ffmpeg`, creates a delivery pack, verifies hashes, verifies receipts, and builds the public service page.

## Current Status

This repo is in 24-hour validation-spike mode. The OKX.AI A2A listing, paid order receipts, customer reviews, funded warranty reserve, and any subcontracted ASP payment must be added only after they are real.
