# Finance parity fixtures

Deterministic, synthetic fixtures for canon §§4-8. The TypeScript server use cases and the Swift `ObolCore` engine must consume the same files and produce the same canonical results. These files are data only. They contain no executable code, no harness, and no real user data.

Parent owns execution and adapter work. This directory only defines the contract.

## Files

| File | Domain |
|---|---|
| `transactions.json` | Transaction lifecycle, money precision, compound-write atomicity |
| `invoices.json` | Card purchases, invoice payments, deletion, projected debt |
| `recurrences.json` | Generation, clamping, idempotency, termination |
| `forecast.json` | Past reconstruction, pending events, invoices, recurrences, simulations |
| `budgets.json` | Accrual budgets by category |
| `projects.json` | Project payments, summaries, completion |

Every case carries a complete initial snapshot. A consumer never loads two files together and never inherits state from another case.

## Protocol

Top level:

```json
{
  "protocol": 1,
  "file": "transactions",
  "title": "human-readable slice title",
  "cases": []
}
```

Case:

```json
{
  "id": "txn-realize-silent",
  "purpose": "one sentence stating the guarded behavior",
  "clock": { "now": "2026-03-08T12:00:00.000Z" },
  "requires": ["effective_at_clock"],
  "divergence": {
    "against": "server",
    "policy": "short_policy_name",
    "source": "path or URL",
    "note": "what differs and why"
  },
  "known_blocker": "short_observed_bug_name",
  "initial": { },
  "commands": [],
  "expect": { }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique across all files, lowercase kebab-case |
| `purpose` | yes | The financial bug or rule the case guards |
| `clock` | yes | Frozen time for the engine and sync operation |
| `requires` | no | Capabilities the consumer must implement to pass |
| `divergence` | no | Known difference between the expected value and a current consumer |
| `known_blocker` | no | Observed production bug the expected value must not bless |
| `initial` | yes | Complete canonical snapshot before any command |
| `commands` | yes | Ordered command intents, applied in array order |
| `expect` | yes | Error, snapshot, projections, or a combination |

Unknown fields are errors. Do not silently ignore them.

## Money

Money is always a decimal string. Never a JSON number.

- Command input money normally uses two decimals: `"123.45"`. The half-cent cases use three: `"1.005"`, `"-1.005"`, `"10.075"`.
- Snapshot and projection money use two decimals: `"0.00"`, `"-650.00"`.
- Comparison parses exact decimal values. `"75"`, `"75.0"`, and `"75.00"` are equal. Scale is not part of the assertion.
- Adapters must not compare binary floating-point values. A TypeScript adapter parses fixture money with a decimal library or exact string arithmetic before comparing.
- Every monetary input reaches product code as the raw decimal string. An adapter must not pre-round, truncate, rescale, or rewrite an input, and must not rewrite product output to match a fixture.
- Rounding sends an exact half toward positive infinity: `1.005` becomes `1.01`, `-1.005` becomes `-1.00`, and `10.075` becomes `10.08`. This is the product contract for `Money.roundCurrency` in `app/ios/ObolCore/Sources/ObolCore/Models.swift` and `roundCurrency` in `server/src/domain/utils/mathUtils.ts`. The Swift `Decimal` implementation is the exact reference; the server implementation rounds the shortest decimal form without a decimal dependency. An adapter must not compensate for either side.

## Dates and clocks

All record dates and every instant in a snapshot or projection are ISO UTC strings with millisecond precision: `2026-03-05T10:00:00.000Z`. No offsets, no local zone.

Calendar keys are not instants:

- `invoices[].period` uses `YYYY-MM`.
- `skipped_periods` entries use `YYYY-MM` on a monthly recurrence and the occurrence day `YYYY-MM-DD` on a weekly one. A weekly entry is the occurrence key for that ISO week, and one array can hold both shapes after a cadence change.
- A weekly occurrence is the UTC midnight of the recurrence `weekday` (ISO 1 = Monday … 7 = Sunday) inside the ISO week that contains the clock. Weekly projection and launch dates use that exact instant; `payday` never drives a weekly occurrence.
- `forecast.generate.start_date` and `.end_date` use `YYYY-MM-DD`.
- `forecast` projection `timeline[].date` uses `YYYY-MM-DD`.

`first_negative_date` is an instant at UTC midnight, for example `2026-03-25T00:00:00.000Z`.

| Clock field | Meaning |
|---|---|
| `now` | The engine clock. Every operation that reads "now" uses this instant. |
| `effective_at` | Optional business time of an offline operation. When present, the operation clock is seeded from it. |
| `applied_at` | Optional server receipt time of a replayed operation. Audit data only. It never supplies a financial date. |

Rules:

- A fixture with `effective_at` must apply the command using `effective_at` as the effective clock for the dated effect. `applied_at` must not appear in `realized_date`, invoice payment rows, project payments, or recurrence launches.
- Without `effective_at`, the dated effect uses `now`.
- Adapters must freeze the clock. A server adapter uses its test clock or fake timers, not the wall clock.
- Dates inside invoice `period` remain `YYYY-MM`.

## Identifiers and captures

Every literal id in a fixture is exactly 15 lowercase alphanumeric characters, for example `acc000000000001` or `txn000000000009`.

Created records get consumer-generated ids. Never assert a generated id. Every successful create command declares a `capture`:

```json
"capture": {
  "pay": {
    "collection": "transactions",
    "where": { "account_id": "acc000000000001", "amount": "40.00", "status": "realized" }
  }
}
```

Capture rules:

1. Resolution happens immediately after the command completes.
2. A capture matches only records created by that command.
3. Exactly one new record must match every `where` key. Zero or multiple matches fail the fixture.
4. `where` values use canonical comparison: money is numeric, dates are exact instants, booleans and relations are normalized.
5. The capture name resolves to the record id. Later commands and expected snapshots use `"$pay"`.
6. A capture does not itself assert an id. It only makes later references deterministic.

`$name` is a reference token. It is valid in any string field of a later command or expected snapshot. A trailing or leading `$` inside ordinary text is not a token.

Expected `title` values may use `"*generated*"`. It matches any non-empty string and is valid only for `title`. It exists for engine-generated labels such as recurrence installments, invoice payments, and default project payments.

## Snapshot shape

A snapshot has all seven collections, even when empty:

```json
{
  "accounts": [],
  "cards": [],
  "categories": [],
  "invoices": [],
  "projects": [],
  "recurrences": [],
  "transactions": []
}
```

`initial` always has all seven keys. `expect.snapshot` also has all seven keys.

Initial records are loaded directly into the consumer's store. Do not replay them through create commands and do not run create-time validation on them. The initial snapshot is a settled current state: realized rows have already moved account balances and invoice totals, and pending rows have not. `accounts[].initial_balance` is the current balance, already including every realized non-silent, non-simulated effect.

### Canonical comparison view

The fixture protocol compares the financial view, not storage artifacts.

| Field | Omitted means | Normalization |
|---|---|---|
| `created`, `updated` | ignored | Never compared. Adapters must strip them. |
| `paid_amount` | `"0.00"` | `null` and `0` are equal. |
| `monthly_budget` | `null` | `null` and absent are equal. Do not turn it into `0` in snapshots. |
| `frequency` | `"monthly"` | `null`, `""`, and `"monthly"` are equal. `"weekly"` is the only other value. |
| `weekday` | `0` | `null`, `0`, and absent are equal. A weekly recurrence compares as an exact integer 1 to 7 (ISO, Monday = 1); a monthly one compares as `0`. |
| `skipped_periods` | `[]` | `null` and `[]` are equal. Order is sorted ascending. Monthly entries are `YYYY-MM`, weekly entries are the occurrence day `YYYY-MM-DD`. |
| `end_date`, `total_installments` | `null` | `null` and absent are equal. |
| `is_recurring` | `false` | `null` and `false` are equal. |
| `is_silent` | `false` | `null` and `false` are equal. |
| `is_simulated` | `false` | `null` and `false` are equal. |
| `is_scheduled` | `false` | `null` and `false` are equal. |
| Any relation (`account_id`, `card_id`, `category_id`, `project_id`, `invoice_id`, `recurrence_id`, `destination_account_id`) | `null` | Empty string and `null` are equal. |
| `realized_date`, `purchase_date` | `null` | `null` and absent are equal. |

A normalized record is compared exactly. An extra record, a missing record, or a different value fails the fixture.

Collections are compared as sets keyed by id. Adapters sort by resolved id before comparing. Array order in the engine is not part of the contract.

## Commands

Commands run in order. A command that returns an error stops the sequence. No later command runs and no earlier command is undone.

| `kind` | Arguments | Server target | Swift target |
|---|---|---|---|
| `account.create` | `record` | `CreateAccountUseCase` / `POST /api/accounts` | `.createAccount` |
| `transaction.create` | `record` | `CreateTransactionUseCase` / `POST /api/transactions` | `.createTransaction(TransactionDraft)` |
| `transaction.update` | `id`, `patch` | `UpdateTransactionUseCase` / `PATCH /api/transactions/:id` | `.updateTransaction` |
| `transaction.realize` | `id`, `update_balance` | `RealizeTransactionUseCase` / `PATCH /api/transactions/:id/realize` | `.realizeTransaction` |
| `transaction.delete` | `id` | `DeleteTransactionUseCase` / `DELETE /api/transactions/:id` | `.deleteTransaction` |
| `transaction.set_simulated` | `id`, `is_simulated` | `PATCH /api/transactions/:id` with `is_simulated` | `.convertSimulation` |
| `invoice.pay` | `card_id`, `period`, `account_id?`, `amount_paid?`, `ignore_balance` | `PayInvoiceUseCase` / `POST /api/cards/:id/pay-invoice` | `.payInvoice` |
| `invoice.delete` | `card_id`, `period` | `DeleteInvoiceUseCase` / `DELETE /api/cards/:id/invoices/:period` | `.deleteInvoice` |
| `invoice.summaries` | `card_id` | `GetCardInvoicesUseCase` | `.cardInvoiceSummaries` plus projection |
| `recurrence.create` | `record` | `CreateRecurrenceUseCase` / `POST /api/recurrences` | `.createRecurrence` |
| `recurrence.set_status` | `id`, `status` | `ToggleRecurrenceStatusUseCase` | `.setRecurrenceStatus` |
| `recurrence.launch` | `id` | `LaunchRecurrenceUseCase` / `POST /api/recurrences/:id/launch` | `.launchRecurrence` |
| `recurrence.process_month` | none | `ProcessMonthlyRecurrencesUseCase` | `.processMonthlyRecurrences` |
| `forecast.generate` | `start_date`, `end_date`, `include_simulations` | `GenerateForecastUseCase` | `ForecastEngine.forecast` |
| `budget.summaries` | none | `GetBudgetsUseCase` | `ForecastEngine.budgetSummaries` |
| `project.payment` | `project_id`, `amount`, `description?` | `RegisterPaymentUseCase` / `POST /api/projects/:id/payment` | `.registerProjectPayment` |
| `project.complete` | `id` | `CompleteProjectUseCase` / `PATCH /api/projects/:id/complete` | `.completeProject` |
| `project.summaries` | none | `ListProjectsUseCase` | `ForecastEngine.projectSummaries` |

Two field conventions matter:

- `transaction.create.record.expected_date` carries the purchase date when `card_id` is set. The resulting row stores that value in `purchase_date` and stores the invoice due date in `expected_date`. This mirrors `CreateTransactionUseCase` and `FinanceEngine.createTransaction`.
- `transaction.update.patch` is a partial update. The expected result is the final financial state after reverting the old effect and applying the new one. The patch does not need to repeat unchanged fields.

`transaction.set_simulated` has no dedicated server use case. The server adapter maps it to the existing PATCH route. The Swift adapter maps it to `.convertSimulation`.

## Fault injection

A command may declare one injected storage failure:

```json
"fault": {
  "on_write": {
    "collection": "accounts",
    "record_id": "acc000000000002",
    "operation": "update"
  },
  "error": "storage_failure"
}
```

| Field | Required | Meaning |
|---|---|---|
| `on_write.collection` | yes | Collection whose write fails |
| `on_write.record_id` | no | Target id. May use `$capture` |
| `on_write.operation` | no | `create`, `update`, or `delete`. Omit to fail any write to the target |
| `error` | yes | Always `storage_failure` in this protocol |

Semantics: the adapter raises the error when the command attempts the matched write. The whole command is atomic. Every write performed by that command is rolled back, including earlier successful writes. The command returns `storage_failure`, and the snapshot must equal the state after the preceding commands.

## Expectations

```json
"expect": {
  "error": { "code": "validation", "entity": "Transaction", "entity_id": "txn000000000001" },
  "snapshot": { },
  "projections": []
}
```

- `error` is present for a failing command. It is the last command. `snapshot` is the state after all preceding commands.
- `snapshot` is present for mutation cases. It is the exact normalized snapshot after all commands.
- `projections` is present when commands produce derived views. The k-th projection command is compared with `projections[k]`.
- At least one of `snapshot` or `projections` is required.
- Error messages and human wording are never compared.

### Projection shapes

#### `forecast`

```json
{
  "kind": "forecast",
  "start_date": "2026-03-01",
  "end_date": "2026-03-25",
  "include_simulations": false,
  "timeline": [{ "date": "2026-03-01", "balance": "1300.00" }],
  "upcoming_invoices": [
    { "card_id": "card00000000001", "card_name": "Visa", "due_date": "2026-03-20T00:00:00.000Z",
      "amount_due": "200.00", "status": "OPEN" }
  ],
  "first_negative_date": "2026-03-25T00:00:00.000Z"
}
```

- `timeline` is ordered by date and covers every day from `start_date` through `end_date`.
- `balance` is the end-of-day balance. It is not the current cash snapshot: past days reconstruct only realized non-silent effects, and today/future include projected obligations (canon §13.1).
- `upcoming_invoices` is ordered by `due_date`, then `card_name`. An unpaid invoice retains its stored `due_date` even when that date is in the past; its deduction lands on `today` (canon §13.2). `status` is the effective forecast status (`OPEN` or `CLOSED`; `PAID` invoices are excluded) and does not rewrite the stored invoice status.
- `first_negative_date` is the first day with `balance < 0`, or `null`.
- Native-only fields such as events, income, and expense are not asserted. The server response does not carry them.

#### `budgets`

```json
{
  "kind": "budgets",
  "as_of": "2026-03-15T12:00:00.000Z",
  "categories": [
    { "category_id": "cat000000000001", "monthly_budget": "350.00", "spent": "410.50" }
  ]
}
```

- Every category in the snapshot appears exactly once, ordered by `category_id`.
- A category without `monthly_budget` projects `"0.00"`.
- `spent` is expenses minus incomes for the month.
- `remaining` and over-budget flags are derived UI values and are not asserted.

#### `projects`

```json
{
  "kind": "projects",
  "projects": [
    { "project_id": "prj000000000001", "status": "completed",
      "total_value": "1000.00", "paid": "500.00", "remaining": "500.00" }
  ]
}
```

- Ordered by `project_id`.
- `paid` counts realized, non-simulated income rows for the project.
- `remaining` is `total_value - paid`.
- Progress ratios are derived UI values and are not asserted.

#### `invoice_timeline`

```json
{
  "kind": "invoice_timeline",
  "card_id": "card00000000001",
  "invoices": [
    {
      "period": "2026-04",
      "due_date": "2026-04-20T00:00:00.000Z",
      "status": "OPEN",
      "debt": "30.00",
      "paid_amount": "0.00",
      "total_spent": "30.00",
      "lines": [
        { "amount": "30.00", "status": "projected",
          "expected_date": "2026-04-10T00:00:00.000Z",
          "recurrence_id": "rec000000000001" }
      ]
    }
  ]
}
```

- `invoices` is ordered by period descending, including the virtual next-period row.
- Invoice `status` is the persisted `OPEN`, `CLOSED`, or `PAID` value. A virtual projected row is identified by its projection marker/status, not by inventing a new persisted invoice status (canon §13.6).
- `debt` is `total_amount - paid_amount`, matching the server `totalAmount` and the Swift `CardInvoiceSummary.totalAmount`.
- `total_spent` is gross spent.
- `lines` are ordered by `expected_date`, then `recurrence_id`.
- A weekly card recurrence contributes one projected line per occurrence whose card due date lands in the invoice period, each with its occurrence purchase date in `expected_date`. An invoice that already holds one weekly child still projects the remaining occurrences of the same period; a monthly recurrence contributes at most one line.
- A real line may carry `id`, `purchase_date`, and `recurrence_id`.
- A projected line omits `id` and `title`: those values are derived and not part of the contract.

## Errors

Canonical codes:

| Code | Meaning |
|---|---|
| `validation` | Invalid amount, date, shape, or relation |
| `not_found` | Entity does not exist |
| `conflict` | Id or month already exists |
| `referenced` | Entity still referenced |
| `already_realized` | Transaction is already realized |
| `already_paid` | Invoice is already paid or has no debt |
| `invalid_state` | Operation is not allowed in the current state |
| `invalid_identifier` | Id is not 15 lowercase alphanumeric characters |
| `storage_failure` | Injected or real persistence failure, full rollback |

Mapping rules:

- Swift `FinanceError.Code` maps one to one: `validation`, `notFound`, `conflict`, `referenced`, `alreadyRealized`, `alreadyPaid`, `invalidState`, `invalidIdentifier`, `writeFailed`.
- Server `DomainError.code` maps `VALIDATION_ERROR`, `NOT_FOUND`, and `CONFLICT` to `validation`, `not_found`, and `conflict`.
- The server has no distinct codes for already-realized, invalid-state, or already-paid. The adapter classifies by command and observed state, never by message text. For example, `transaction.realize` on a realized row is `already_realized`, and `invoice.pay` on a paid invoice is `already_paid`.
- `entity` and `entity_id`, when present in the fixture, are compared. Adapters derive them from the command target when the underlying error has no fields.

## Capability flags

| Flag | Meaning |
|---|---|
| `exact_decimal_money` | Fixture money is parsed and compared as exact decimals |
| `relation_validation` | Canonical relation and shape validation runs before writes |
| `atomic_compound_writes` | A command writes all collections or none |
| `effective_at_clock` | A sync operation seeds the financial clock from `effective_at` |
| `invoice_projection` | The consumer can build the projected invoice timeline |

`requires` lists the product capabilities a case exercises. They are mandatory for a passing suite: a case with a missing capability fails. A suite that reports `SKIPPED` does not pass, and no capability-based skip counts as a pass. PAR-01 passes only when every case in every file passes.

### Adapter prohibitions

An adapter maps commands and records, normalizes the canonical comparison view, injects the case clock, and injects the declared persistence fault. It must not:

- add missing business behavior, including a native invoice projection or a virtual `PROJECTED` row;
- filter, recompute, correct, or round server project paid totals, budgets, forecast balances, or invoice totals;
- pre-round, rescale, or rewrite a subcent input before product code sees it;
- rewrite product output so a fixture passes.

A missing target behavior is a product defect. The fix belongs in the server use case or `ObolCore`, and the fixture stays expected until the product passes it.

## Known divergences and blockers

| Fixture | Kind | Contract |
|---|---|---|
| `inv-payment-atomic-failure` | Divergence | The server writes the account debit, payment row, invoice, and child updates as separate repository calls; no unit of work exists yet. The expected full rollback is the contract. |
| `txn-transfer-atomic-failure` | Known blocker | The observed failure left source `100 → 75` and destination `50`. Expected result is `100` and `50`. Product regression evidence is still required. |
| `txn-create-realized-simulation`, `txn-realize-simulated` | Known blocker | The observed realized simulation moved checking `850 → 810`. Expected result is `850`. Product regression evidence is still required. |

## TypeScript adapter rules

1. Freeze time at `clock.now` for every use case that calls `Date()`.
2. For `effective_at` cases, seed the scoped operation clock and never let the receipt time supply a financial date.
3. Map commands to the use cases in the command table. Use the existing controllers' DTO field names.
4. Pass `transaction.update.patch` unchanged as a partial intent. The product use case computes the final state from the stored record plus the patch; the adapter must not fill in the missing fields.
5. Capture created records by querying the repositories after each command. Compare `where` values with the canonical view.
6. Normalize records before comparing snapshots: strip `created` and `updated`; map empty relations to `null`; map missing flags to `false`; map missing `paid_amount` to `"0.00"`; normalize `skipped_periods`.
7. Pass money inputs to the product unrounded, and compare money with exact decimal parsing. Do not compare JS numbers directly and do not round either side in the adapter.
8. Map forecast fields: `timeline[].date` and `timeline[].balance`; map `upcomingInvoices[].card_id`, `card_name`, `dateStr` to `due_date`, `amount` to `amount_due`, and `status`. Derive `first_negative_date` as a presentation field from the product timeline, at UTC midnight; do not recompute a balance.
9. Map invoice projection fields: `totalAmount` to `debt`, `paidAmount` to `paid_amount`, `totalSpent` to `total_spent`. Drop projected line ids and titles. The product owns the projected rows.
10. Map the product's `received` field to `paid`. Do not filter, recompute, or reapply the realized-income rule in the adapter; the product owns it. Compute `remaining` from the product's `total_value` and `paid`.
11. Inject the budget clock. Map `monthly_budget` and `spent`.
12. Fault injection wraps repository writes. On trigger, abort and roll back the whole command.

## Swift adapter rules

1. Decode fixture money with `Decimal(string:)`, never `Double`.
2. Decode dates with the ISO-8601 fractional-seconds parser and UTC calendar. `ObolDate.parse` and `ObolDate.normalize` satisfy the protocol.
3. Apply commands with `now` equal to `clock.effective_at` when present, otherwise `clock.now`.
4. Map commands to `FinancialCommand`:
   - `transaction.create` builds a `TransactionDraft` with `id: nil`.
   - `transaction.update` builds a `TransactionPatch` from the partial `patch`.
   - `transaction.set_simulated` maps to `.convertSimulation`.
5. Capture created records from the returned snapshot by applying the same `where` matching rules.
6. `FinanceEngine.apply` is value-typed. A thrown `FinanceError` leaves the caller's snapshot untouched. Verify that property when implementing fault injection.
7. Normalize `nil` and `false`, `nil` and `[]`, `nil` and `""` before comparing.
8. `budgetSummaries` uses its `at` parameter for the month. `projectSummaries` already counts realized, non-simulated income only. Pass raw money into the engine and map its output; never recompute a budget or project total in the adapter.
9. `cardInvoiceSummaries` implements the canon §5 and §13.6 projected timeline in product code, including the virtual next-period row and a projection status separate from the persisted `OPEN`/`CLOSED`/`PAID` status. The adapter maps the returned rows and must not synthesize a projection.
10. `ForecastEngine.forecast` owns the canon §13.1-§13.3 forecast policy. Keep the product result and treat any server difference as a product defect to fix, not as an adapter workaround or a bug to copy.

## Fixture inventory

### transactions.json

| Id | Purpose |
|---|---|
| `txn-realize-ordinary` | Realize moves 25.00 once and clears `is_scheduled` |
| `txn-realize-silent` | Silent realize stamps the row realized without moving cash |
| `txn-realize-already-realized` | Second realize is `already_realized` and changes nothing |
| `txn-realize-simulated` | Simulated rows cannot realize and never debit cash |
| `txn-create-realized-simulation` | Realized simulated expense leaves 850.00 intact |
| `txn-convert-simulation` | Conversion does not move cash; the later realize does |
| `txn-money-half-cent` | Exact halves round `-1.005 → -1.00` and `1.005 → 1.01` |
| `txn-create-half-cent-cash` | A 1.005 expense is stored as 1.01 and debits 1.01 |
| `txn-edit-realized` | Editing 30.00 to 50.00 leaves 50.00 |
| `txn-delete-realized` | Deleting a realized expense restores 100.00 |
| `txn-transfer-neutral` | Transfer moves 25.00, clears category, and keeps net worth |
| `txn-transfer-atomic-failure` | Destination write failure rolls the source back to 100.00 |
| `txn-effective-at-offline` | Replay on March 9 keeps the March 5 business date; `effective_at` is March 5 10:00Z and `applied_at` is March 9 12:00Z |
| `txn-midnight-boundary` | UTC midnight realization keeps the February expected date |
| `txn-invalid-same-account` | Transfer with identical source and destination is rejected |
| `txn-invalid-missing-account` | Unknown account reference is `not_found` |

### invoices.json

| Id | Purpose |
|---|---|
| `inv-card-purchase-boundary` | Closing-day purchases move to the next invoice |
| `inv-year-rollover` | December 31 purchase lands in February 2027 |
| `inv-partial-payment` | 40.00 of 100.00 debits the account and keeps the child pending |
| `inv-full-payment` | Full payment marks PAID and realizes the child |
| `inv-silent-payoff` | Silent payoff realizes the child without account or paid_amount change |
| `inv-payment-exceeds-debt` | 120.00 against 100.00 is rejected |
| `inv-child-delete` | Deleting a child reduces the total and skips the recurrence month |
| `inv-delete-invoice` | Deleting the invoice removes children and skips the period |
| `inv-projection-no-double-count` | Projection adds 2026-04 and 2026-05 rows but not 2026-03 |
| `inv-weekly-card-projection` | A weekly card recurrence projects one line per occurrence; four 50.00 lines remain 200.00 |
| `inv-payment-atomic-failure` | Invoice write failure rolls back the account and payment row |

### recurrences.json

| Id | Purpose |
|---|---|
| `rec-payday-clamp-february` | Payday 31 generates February 28 |
| `rec-month-idempotency` | Cron skips March and launch conflicts on April |
| `rec-pause-resume` | Paused recurrence waits; resumed recurrence generates the month |
| `rec-end-date-expiry` | An occurrence after `end_date` ends the recurrence |
| `rec-finite-installments` | Three installments generate the third and then end |
| `rec-launch-next-month` | Launch creates April 30; a second launch conflicts |
| `rec-launch-card-invoice` | Card launch creates the April invoice and due date |
| `rec-skipped-period` | Cron does not generate a skipped month |
| `rec-deleted-child-skips` | Deleting a child prevents regeneration of that month |
| `rec-ended-launch-error` | Ended recurrence rejects manual launch |
| `rec-invalid-account-and-card` | Recurrence cannot use both account and card |
| `rec-weekly-current-week` | A weekly recurrence generates the current ISO week's Tuesday, not the payday |
| `rec-weekly-same-week-idempotent` | A second run in the same ISO week adds no child |
| `rec-weekly-skip-key` | A skipped occurrence day suppresses that ISO week |
| `rec-weekly-launch-next-week` | Launch targets the next ISO week's occurrence |
| `rec-weekly-installments` | A weekly installment plan yields the exact title `Rent - Parcela 2/2` |
| `rec-weekly-week-crosses-month` | The ISO week containing 2027-01-01 generates 2026-12-31 |

### forecast.json

| Id | Purpose |
|---|---|
| `fcst-rollback-and-pending` | One timeline covers rollback, pending, invoice, recurrence, and both simulation modes |
| `fcst-overdue-pending` | An overdue pending row is projected on today, not at a past date |
| `fcst-investment-exclusion` | Investment accounts and their rows stay out of the forecast |
| `fcst-unassigned-pending` | Unassigned pending rows affect aggregate cash, simulations follow the toggle, and a realized unassigned project income moves no cash |
| `fcst-overdue-invoice-past` | An unpaid invoice due before today is deducted on today, leaving reconstructed past days unchanged |
| `fcst-transfer-to-investment` | A liquid-to-investment transfer moves liquid cash by only the liquid side |
| `fcst-weekly-occurrences` | A weekly expense projects one event per ISO week and skips the launched current-week occurrence |

### budgets.json

| Id | Purpose |
|---|---|
| `budget-accrual` | Purchase-date accrual, month edges, simulations, and income subtraction |

### projects.json

| Id | Purpose |
|---|---|
| `project-payment-lifecycle` | Payments, pending exclusion, completion, and unchanged total value |
| `project-payment-missing` | Unknown project returns `not_found` |

## Authoring rules

- No real user data. Every name, amount, and id is synthetic.
- No generated ids and no incidental wording in expected values. Use captures and `*generated*`.
- No source-text tests, tautologies, mock echoes, or default-only rows.
- Every case must guard a plausible financial bug.
- A fixture change requires a matching change in both consumers in the same wave.
