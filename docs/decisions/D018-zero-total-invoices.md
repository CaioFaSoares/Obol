# D018 - Zero-total invoices are valid

**Status**: accepted · **Date**: 2026-11-01 · **Target release**: 0.4.0 · **Related**: [D002](D002-invoices-table.md), [D016](D016-native-offline-sync.md)

## Context

`invoices.total_amount` was declared `required: true` in migration `1700000007`. PocketBase treats the number `0` as blank for a required numeric field, so a row with `total_amount: 0` is rejected:

```
{"total_amount":{"code":"validation_required","message":"Cannot be blank."}}
```

Reproduced against the pinned PocketBase 0.40.6 with the current migration set, creating one fixture invoice row with `period: 2026-04` and `total_amount: "0.00"`.

A zero-total invoice is legitimate domain state. `docs/canon.md` §5 has invoices keyed by `(card_id, period)`, `GetCardInvoicesUseCase` computes real debt, gross spent and projected rows per invoice, and `ReconcileInvoicesUseCase` rewrites `OPEN`/`CLOSED` totals from children. A card period with no purchases therefore has an invoice with zero debt and zero gross spent, and the invoice timeline reports it as `total_spent: 0.00`. The finance parity fixture `inv-projection-no-double-count` depends on exactly that row.

## Decision

- Relax `invoices.total_amount` to `required: false` in migration `1700000022_allow_zero_invoice_total.js`. No other field, rule or index changes; the numeric constraints stay as they are.
- The domain still treats `total_amount` as present: use cases always write a number, and reads keep the existing zero handling. Only the PocketBase blank check is removed.
- The rollback restores `required: true` only when no invoice carries a null or zero total, and refuses with the violating count otherwise.
- This follows the precedent of `1700000003_allow_zero_balance.js`, which relaxed a required numeric field for the same reason.

## Consequences

- Card periods with no purchases can be stored, so the invoice timeline, reconciliation and delete flows no longer fail on a zero delta.
- Fixtures that seed a zero-total invoice work against real PocketBase instead of being special-cased in the harness.

## Verification

- Fresh and existing volumes migrate to the same schema.
- The parity case `inv-projection-no-double-count` seeds its rows and passes against the pinned PocketBase image.
