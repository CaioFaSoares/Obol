# Context — canonical vocabulary

Every domain term with its canonical meaning and the synonyms agents must avoid. Canonical names are exactly the identifiers in code (`canon.md §3`).

| Term | Meaning | Avoid |
|---|---|---|
| `transaction` | A money event: `income`, `expense`, or `transfer`; `pending` until realized | "lancamento", "entry", "movement" |
| `realize` (baixa) | Transition `pending → realized` with `realized_date = now`; optional balance mutation | "pay", "settle" (for the general case) |
| silent realize (baixa silenciosa) | Realize with `update_balance = false`, writes `is_silent: true`; no balance change | "no-op realize", "dry run" |
| `is_scheduled` | Marks an agenda/scheduled item; cleared to `false` on realize | "recurring", "agenda flag" |
| `is_simulated` | What-if row; excluded from tabs and forecast unless requested | "fake", "draft", "forecast flag" |
| `is_silent` | Marker that a realize did not move balances | — |
| `purchase_date` | Real date of a card purchase; drives accrual (budgets, idempotency) | "buy date", "transaction date" |
| `expected_date` | Commitment date; for card purchases equals the invoice `due_date` | "due date" (outside invoices) |
| `invoice` | A card billing month row: `card_id` + `period` (`YYYY-MM`) + `due_date` + `status`/amounts | "bill", "fatura" |
| `period` | `YYYY-MM` string keying invoices and `skipped_periods` | "month", "cycle" |
| `recurrence` | The rule (parent); generates transaction facts monthly on `payday` (clamped to month length) or weekly on `weekday` (UTC ISO week, exact date) | "subscription" (it covers salaries too), "recorrencia" |
| `frequency` | Recurrence cadence: `monthly` (absent/default) or `weekly` (D019) | "interval", "periodicity" |
| `weekday` | ISO weekday 1-7 (Monday first) anchoring a weekly recurrence; `0`/absent for monthly | "day of week index", "dia da semana" as an identifier |
| `occurrence` | The dated fact a recurrence generates for one cadence period: `YYYY-MM` monthly, `YYYY-MM-DD` weekly | "instance", "slot" |
| `skipped_periods` | Recurrence periods whose generated transaction was deleted/manual; blocks regeneration; holds both key shapes | "skip list" |
| `launch` (lançar agora) | `LaunchRecurrenceUseCase`: generate the *next* month's or next ISO week's transaction manually | "realize", "create transaction" |
| idempotency rule | Generation skips if a transaction already exists for that month (monthly) or that occurrence day (weekly) | "dedup" |
| clamping | `payday` beyond month length is pulled to the last day; weekly dates are never clamped | "date fix" |
| `closing_day` / `due_day` | Card cycle boundaries; invoice math via `calculateCardDueDate` | "close date", "vencimento" |
| forecast | Daily balance timeline: past rollback + forward projection, `roundCurrency` math | "projection" (when naming the use case), "budget" |
| budget | Category `monthly_budget`, consumed accrually on `purchase_date`/`expected_date` | "pot", "pote" |
| realization conversion | Ledger action turning an `is_simulated` row into a real account/card transaction | "materialization" (UI copy only) |
| BFF | `server/` — ElysiaJS on Bun; the only process that talks to PocketBase | "backend" (when distinguishing from PocketBase) |
| The Triad | `app/` + `server/` + `db/` as strict layers (D001) | — |
| PocketBase | `db/` — SQLite persistence; public API rules `null` | "the database server" (it is the data layer) |
