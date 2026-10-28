# Canon

Obol's numbered source of truth. Every other doc links into this one instead of repeating it. Sections are addressed as `canon §N` from anywhere in the repo. Rules change only by appending a new numbered subsection or superseding a decision in `decisions/` — history is never rewritten silently.

Related: [arquitetura.md](arquitetura.md) · [decisions/log.md](decisions/log.md) · [history/](history/README.md)

## §1 What Obol is

Obol is a personal cash-flow forecaster: granular control of accounts, credit cards, budgets and freelance projects, with a daily projection showing the exact day cash runs out. Unlike static budgeting tools, it reconstructs past balances from realized transactions and projects future balances from pending items, invoices and recurrences.

## §2 Architecture

Three layers with one responsibility each (D001), server layered by clean architecture (D003):

- `app/` — Nuxt 3 + Nuxt UI + Pinia + ECharts. Talks only to the BFF via Eden Treaty.
- `server/` — ElysiaJS on Bun, clean architecture (domain / application / infrastructure), awilix DI, isolated cron scheduler.
- `db/` — PocketBase v0.23+, public API rules `null`, JS migrations on boot.

Module map and runtime topology: [arquitetura.md](arquitetura.md).

## §3 Data model

Collections (PocketBase): `accounts`, `cards`, `categories`, `invoices`, `projects`, `recurrences`, `transactions`. Entities in `server/src/domain/entities/`.

| Collection | Fields |
|---|---|
| `accounts` | `name`, `type` (`checking`\|`savings`\|`investment`), `initial_balance` |
| `cards` | `name`, `closing_day`, `due_day`, `limit` |
| `categories` | `name`, `type` (`fixed_budget`\|`variable`), `monthly_budget?` |
| `invoices` | `card_id`, `period` (`YYYY-MM`), `due_date`, `status` (`OPEN`\|`CLOSED`\|`PAID`), `total_amount`, `paid_amount?` |
| `projects` | `name`, `total_value`, `status` (`active`\|`completed`) |
| `recurrences` | `name`, `amount`, `payday`, `type` (`income`\|`expense`), `status` (`active`\|`paused`\|`ended`), `account_id?`, `card_id?`, `category_id?`, `end_date?`, `total_installments?`, `skipped_periods?` |
| `transactions` | `title`, `amount`, `type` (`income`\|`expense`\|`transfer`), `status` (`pending`\|`realized`), `expected_date`, `realized_date?`, `purchase_date?`, `is_recurring?`, `is_silent?`, `is_simulated?`, `is_scheduled?`, `account_id?`, `card_id?`, `category_id?`, `project_id?`, `invoice_id?`, `recurrence_id?`, `destination_account_id?` |

Parent-child: `recurrences` is the *rule*, `transactions` are the *facts* it generates.

## §4 Transaction lifecycle

- Born `pending` with `expected_date`; card purchases are born pending with `expected_date = invoice.due_date` and `purchase_date` = real purchase date.
- Realize (`RealizeTransactionUseCase`): pending → realized, stamps `realized_date = now`, moves balances. `update_balance = false` = silent realize (`is_silent: true`): no balance mutation — for when the user already adjusted the balance manually.
- Transfers are atomic: subtract source, add destination, clear `category_id`/`card_id`, no net-worth impact.
- `is_scheduled` marks scheduled/agenda items; always cleared to `false` on realize.
- `is_simulated` marks what-if rows; excluded from realized/pending tabs and from the forecast unless `includeSimulations = 'true'`.
- Edit (`UpdateTransactionUseCase`) reverts the old financial effect, then applies the new one (balance- and invoice-aware).
- Delete (`DeleteTransactionUseCase`) reverts balances, adjusts the invoice total, and appends the purchase period to the source recurrence's `skipped_periods` so the cron does not regenerate it.

## §5 Invoice engine

- `SyncInvoiceUseCase`: `calculateCardDueDate(purchaseDate, closing_day, due_day)` (pure UTC math, month rollover safe) → period = due month → find/create invoice for card+period → delta into `total_amount`.
- Invoice status: `PAID` when all children realized, `CLOSED` past closing date, else `OPEN`.
- `GetCardInvoicesUseCase` computes per-invoice real debt (`total_amount − paid_amount`), gross spent, and injects *projected* rows for active card recurrences; one virtual `PROJECTED` invoice for the next period.
- `PayInvoiceUseCase`: requires `accountId`, validates `amountPaid` against `total_amount − paid_amount`, debits the account, records a realized `Pagamento Fatura <card> <period>` transaction; partial payments bump `paid_amount`; full payment flips child pendings to realized. `ignoreBalance` = silent payoff.
- `DeleteInvoiceUseCase`: removes children, appends periods to recurrence `skipped_periods`.

## §6 Recurrence engine (time)

- Scheduler: daily cron at 01:00 `America/Fortaleza` (`@elysiajs/cron`), runs `ReconcileInvoicesUseCase` then `ProcessMonthlyRecurrencesUseCase`.
- Monthly processing: expiry (`end_date`), finite installments (`total_installments` counted from existing children), month idempotency (skip if a transaction already exists for the month, matched on `purchase_date` or `expected_date`), `skipped_periods` skip, `payday` clamped to month length (payday 31 → 28).
- `LaunchRecurrenceUseCase` ("lançar agora"): generates the *next* month's pending transaction on demand; `ConflictError` if it already exists.
- Pausing (`paused`) stops generation; manual launch and cron resume recognize prior months via idempotency.

## §7 Forecast engine

`GenerateForecastUseCase`: inputs are non-investment accounts, transactions, active recurrences, unpaid invoices (upcoming `amountDue > 0` → dated due events). Past: reverses realized non-card non-silent transactions from a summed account snapshot, then rebuilds forward day-by-day. Future: pending transactions on `expected_date`, invoice due amounts on `due_date`, future recurrences on `payday` unless already launched (`alreadyLaunched` check). `includeSimulations` controls simulation rows. All math via `roundCurrency`.

## §8 Budgets, projects, reconciliation

- Budgets (`GetBudgetsUseCase`, accrual): expenses count on `purchase_date` when set (card), else `expected_date` — regardless of status; `spent` = expenses − incomes per category.
- Projects: `RegisterPaymentUseCase` records partial income transactions; `CompleteProjectUseCase` closes. Payment registration does not mutate `total_value`.
- `ReconcileInvoicesUseCase` (daily): reattaches orphan card transactions, recalculates `OPEN`/`CLOSED` invoice totals from children (rewrites if `|diff| > 0.01`), prunes `skipped_periods` older than 3 months.

## §9 Frontend data flow

- `stores/finance.ts` caches `accounts`/`cards`/`categories`/`projects` (`loadBaseData(force)`); `useRefresh` broadcasts a global refresh counter; every mutation triggers `triggerRefresh()` + refetch.
- Pages: dashboard (forecast chart, 15/30/60/90-day range, simulation toggle, Realizados/Pendentes/Simulados tabs), `ledger` (paginated table, title search `title ~`, status/type/simulation/scheduled filters, client-built PocketBase filter string), `cards` (invoice timeline + payment), `management` (Contas & Cartões / Recorrências / Orçamentos / Projetos), `admin`.

## §10 Operations

- Dev: `nix develop` → `docker-compose up -d --build` → app :13000, server :13080, PocketBase :13090 (admin `/_/`).
- Deploy: `docker-compose.coolify.yml` (expose-only, Coolify reverse proxy).
- Env: `PB_ADMIN_EMAIL`, `PB_ADMIN_PASSWORD` (`.env` from `.env.example`), `POCKETBASE_URL`, `PORT`.
- Migrations: `db/pb_migrations/*.js`, executed by PocketBase on boot.

## §11 Roadmap

Planned epics (order to be sequenced): E001 — local Electrobun build + ledger strengthening ([epics/E001-ledger-electrobun.md](epics/E001-ledger-electrobun.md)); E002 — thin use-case dispatch layer ([epics/E002-thin-usecase-middleware.md](epics/E002-thin-usecase-middleware.md)). Historical roadmap: [history/2026-05-map.md](history/2026-05-map.md).
