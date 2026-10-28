# D002 - Invoices as a first-class table

**Status**: accepted (2026-05-26, commits `3655b8e`, `ed22b4f`; schema `1700000006_create_invoices`, `1700000007_fix_invoices_fields`)

## Context
Card purchases on credit do not leave the checking account until the invoice is paid. Computing open invoices on the fly from transactions made the forecast loop heavy and error-prone.

## Decision
- Card transactions are stored with `purchase_date` (accrual date) and grouped into a dedicated `invoices` collection.
- The transaction interceptor computes `closing_day`/`due_day` windows via date clamping and assigns the transaction to the correct current or future invoice.
- Installment purchases generate their parcel transactions over time and auto-terminate when paid off.
- Invoices support partial payments and early full payment; transaction matching keeps the cash flow trajectory accurate.
- Budget consumption is accrual-based: a credit purchase debits the category budget on `purchase_date`, not on invoice due date.

## Consequences
- Invoice math happens once at write time, not per forecast request.
- Category budgets reflect real credit exposure immediately, avoiding false surpluses.
