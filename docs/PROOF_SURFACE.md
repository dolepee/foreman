# Proof Surface

Foreman proof is designed to support the delivery, not replace the product.

## Receipt Fields

Each delivery receipt includes:

- `orderId`
- `sku`
- `paymentStatus`
- `scopeHash`
- input material hashes when the input can be stored or referenced safely
- output hashes
- QA checklist results
- warranty state
- OKX.AI listing, order, escrow, and subcontract references when real

## Rules

- Local validation samples are marked as samples.
- Customer orders are counted only after real OKX.AI payment/order proof exists.
- Reviews are counted only after customers leave them.
- Subcontracting is claimed only after a real listed ASP is hired and paid.
- Customer raw material is not committed to the repo.

## Verification

```bash
npm run delivery:verify
npm run proof:verify
```
