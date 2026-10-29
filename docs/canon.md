# Canon

Obol's numbered source of truth. Every other doc links into this one instead of repeating it. Sections are addressed as `canon §N` from anywhere in the repo. Rules change only by appending a new numbered subsection or superseding a decision in `decisions/` — history is never rewritten silently.

Related: [arquitetura.md](arquitetura.md) · [decisions/log.md](decisions/log.md) · [history/](history/README.md)

## §1 What Obol is

Obol is a personal cash-flow forecaster: granular control of accounts, credit cards, budgets and freelance projects, with a daily projection showing the exact day cash runs out. Unlike static budgeting tools, it reconstructs past balances from realized transactions and projects future balances from pending items, invoices and recurrences.

## §2 Architecture

Three layers with one responsibility each (D001), server layered by clean architecture (D003):

- `app/` — Nuxt 3 + Nuxt UI + Pinia + ECharts. Talks only to the BFF via Eden Treaty.
- `server/` — ElysiaJS on Bun, clean architecture (domain / application / infrastructure), awilix DI, isolated cron scheduler.
- `db/` — PocketBase persistence, public API rules `null`, JS migrations on boot. Desktop bundles pinned PocketBase 0.40.6 (D005); hosted Compose still uses the configured PocketBase image.

Module map and runtime topology: [arquitetura.md](arquitetura.md).

Runtime modes: hosted web uses the Nuxt same-origin proxy to the Elysia BFF; local desktop uses Electrobun, a managed local PocketBase child, and Eden-to-Elysia IPC (D005). No hosted server or Docker is required for the desktop app.

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
- Pages: dashboard (daily balance summary, 15/30/60/90-day forecast and simulation controls, daily balance calendar with shared chart/day details, trajectory chart, realized/pending/simulated transaction tabs with edit/realize actions, quick entry, and shortcuts to ledger/cards/management), `ledger` (paginated table, structured search/status/type/simulation/scheduled/date/entity filters, sort, filtered totals, lifecycle badges, CSV export), `cards` (invoice timeline + payment), `management` (Contas & Cartões / Recorrências / Orçamentos / Projetos), `admin`. The desktop `DesktopUpdaterBanner` shows update status, retry, download progress, and restart-to-install state; the updater checks and downloads in the packaged main process.
- Ledger summary returns filtered `incomeTotal`, `expenseTotal`, `netTotal`, and `count`; transfer rows contribute to count but not money totals. Account filters match both `account_id` and `destination_account_id`; realized-date filtering uses `realized_date`, otherwise date ranges use `expected_date`.

## §10 Operations

- Hosted dev: `nix develop` → `docker compose up -d --build` → app :13000, server :13080, PocketBase :13090 (admin `/_/`).
- Desktop: `nix develop`; install `app/`, `server/`, and `desktop/` dependencies; `cd desktop && bun run eb:dev`. The local setup/unlock gate uses `copland.obol.eb-dev`; packaged identity/data use `copland.obol`.
- Desktop data: `Utils.paths.appData/copland.obol/pb_data`; no automatic import from hosted `db/pb_data`, which remains unchanged.
- Local login: one profile per application-data directory; `local_profile.json` stores a salted PBKDF2 verifier. Each unlock derives the internal PB superuser credential and runs `superuser upsert` before the service starts. The login does not encrypt PB files at rest.
- Deploy: `docker-compose.coolify.yml` (expose-only, Coolify reverse proxy). Release PRs to `main` validate macOS arm64/x86_64 and Windows x64 without publishing; merging `dev` or `pr/release-<version>` creates `release-<version>`, publishes platform installers plus Electrobun updater metadata/full bundles, retains a macOS manifest for the Homebrew cask, then updates the cask.
- Env: hosted uses `PB_ADMIN_EMAIL`, `PB_ADMIN_PASSWORD` (`.env` from `.env.example`), `POCKETBASE_URL`, `PORT`. Desktop creates its local profile on first launch.
- Migrations: `db/pb_migrations/*.js`, executed by PocketBase on boot.

## §11 Roadmap

Implemented epics: E001 — ledger hardening + local Electrobun runtime; E002 — typed use-case dispatch; E003 — daily dashboard/calendar; E004 — Windows x64 release pipeline. Release 0.2.0 is published. E005 repairs the 0.2.0 migration path and adds the in-app updater for 0.2.0a. Because 0.2.0 has no updater, users must install 0.2.0a manually once; later stable releases can update in-app. Historical roadmap: [history/2026-05-map.md](history/2026-05-map.md).
