# E003 - Dashboard operations (0.2.0)

**Status**: implementation in progress · **Completed**: —
**Related**: `docs/canon.md §1`, `§3`, `§4`, `§5`, `§7`, `§9` · `app/pages/index.vue` · `app/components/ForecastChart.vue` · `app/components/ForecastCalendar.vue` · `app/components/FastEntryModal.vue` · `app/components/TransactionEditModal.vue` · `app/layouts/default.vue`

## Goal

Turn the dashboard from a working demo of the forecast engine into the day-to-day operational surface of Obol: the place where a user opens the app, sees where the cash stands, reads the daily trajectory, and acts on it — realize, edit, launch, pay — without leaving the page. The one net-new capability in this epic is a **daily projected-balance calendar**: a month grid where every day shows its projected balance and can be selected to inspect what lands that day, complementing the ECharts trajectory.

Orchestration rule from this file onward in 0.2.0: the dashboard is where *operations* happen; `ledger` stays the deep-audit surface. The dashboard optimizes speed of interaction over exhaustiveness, never at the cost of the balance/forecast semantics below.

## Baseline (already verified before this epic)

Existing dashboard capability, per canon §9 and `app/pages/index.vue`:

- **Balance cards** — "Caixa Atual (Hoje)" (summed balance of non-investment accounts) and "Projeção (+N dias)" (closing point of the forecast timeline, colored positive/negative).
- **Forecast chart** — `ForecastChart` (ECharts) over the `/api/forecast` timeline; point click opens a "Composição do Saldo" modal that lists the decisive transactions up to that day.
- **Range and simulation toggle** — 15/30/60/90-day range dropdown; "Modo Simulação" toggle that adds simulation rows to the forecast (`includeSimulations`, canon §7) and surface a third "Simulados" tab.
- **Transaction lists** — Realizados / Pendentes (/ Simulados) tabs, 15-per-page "Carregar mais" pagination, status/scheduled/silent badges, sign- and type-colored amounts, card transactions filtered out of the lists.
- **Realization** — per-row realize menu preserving the canon §4 duality: "Dar baixa e somar no saldo" (`update_balance: true`) vs. "Já está no saldo (Baixa Silenciosa)" (`update_balance: false`). Scheduled rows ("Agendado") are not realizable before their date.
- **Edit** — row edit icon opens the shared `TransactionEditModal` via `useTransactionEdit`; mutation reverts the old financial effect then applies the new one (canon §4), then `triggerRefresh()` refetches everything.
- **Card invoice routing** — virtual invoice rows derived from `upcomingInvoices` (canon §5, `GetCardInvoicesUseCase`) render in the pending list; their action routes to `/cards?card_id=…` instead of realizing inline, keeping payment inside the cards module (`PayInvoiceUseCase`).
- **Quick entry** — `FastEntryModal` in the app layout: fast expense/income/transfer registration, with simulated and scheduled variants, launched from any page including the dashboard.
- **Finance module navigation** — top nav in `layouts/default.vue` routes Dashboard / Ledger / Cartões / Gestão / Admin.
- **Global refresh** — `useRefresh` broadcasts a counter; every dashboard mutation triggers a full refetch (canon §9).

## New scope: daily projected-balance calendar

A compact month calendar (`app/components/ForecastCalendar.vue`) that shares the forecast timeline already fetched by the page — no new API call.

### Component contract

- Props: `data?: any[]` (timeline points with `date` and `balance`), `selected-date?: string` (optional, controlled highlight).
- Emits: `select` with `{ date: string, balance: number }` for the clicked day. The page decides what showing day details means (same modal used by the chart today is the default integration).
- Self-contained month navigation (prev/next); never mutates props' source data.
- The dashboard page keeps ownership of data and details; the calendar is presentational + local view state.

### Calendar behavior

- Each day cell previews its **projected balance** (`balance` of that day's timeline point), colored positive/negative.
- **Today affordance**: today is visually marked even before selection, as the boundary between reconstructed past (canon §7 "rebuilds forward day-by-day") and projection.
- **Days without forecast data** (before range start / after range end, in months outside the fetched window): rendered as silent muted slots — no clickable promise, no invented balance.
- **Month overflow**: leading/trailing slots of the grid stay visible but muted; navigation does not allow further than the received data except to show truly empty months (muted).
- **Accessible keyboard operation**: every day, and both month-nav buttons, are real focusable buttons; `select` fires on Enter/Space like on click; selection state is announced via `aria-selected`/`aria-pressed`; the grid carries no unlabeled icon-only controls.
- Selection honors the payload currently shown, so an external `selected-date` prop highlights without scroll jumps.

## Guardrails (semantic, from canon)

These invariants are non-negotiable in every new dashboard surface, including the calendar:

1. **Balance composition (canon §7).** "Current cash" covers only non-investment accounts (`type ≠ 'investment'`). The forecast rebuilds past balances from realized history and projects future balances from pending transactions, unpaid invoices, and active recurrences. Any surface that quotes a balance must say which one: current vs projected (day N) — never a bare number without a label.
2. **Simulations stay simulated (canon §4, §7).** `is_simulated` rows are excluded from Realizados/Pendentes and from the forecast unless `includeSimulations = 'true'`. They never shift the plain projections; toggling simulations on changes only the *preview*, never the realized history or pending state.
3. **Realize semantics (canon §4).** Pending → realized only via the realize action; the two realize variants (`update_balance` true/false) are distinct paths with distinct toasts. Realize stamps `realized_date = now`, clears `is_scheduled`, and is balance- and invoice-aware. Scheduled items show the "Agendado" state and are not presented as realizable, matching `is_scheduled` always cleared to `false` on realize (canon §4).
4. **Transfer semantics (canon §4).** Transfers are atomic: subtract source, add destination, zero net-worth impact. Transfer rows show no income/expense coloring and are not counted in money totals.
5. **Silent realize exists and is honored.** `update_balance = false` = "already moved manually": no balance mutation; shows in the surface that no balance was touched (canon §4, `is_silent: true` badge).
6. **Edit is financial (canon §4).** Editing reverts the old effect before applying the new one, including invoice total and balance changes. The surface must not pre-estimate the new balance client-side; it refetches on `triggerRefresh()`.
7. **Invoices route, never realize inline (canon §5).** Virtual invoice rows in pending lists are *due amounts* computed from `total_amount − paid_amount` and projected recurrence rows — not standalone transactions. Their action routes to the cards module for `PayInvoiceUseCase`; the dashboard never debits an account for an invoice payment.
8. **Today-edge consistency.** The "current" balance and the timeline point for today come from the same forecast pass (§7 does not double-count snapshot + events). Balance cards and calendar must agree on that boundary for the same `includeSimulations` and range settings.
9. **Currency rendering.** All amounts flow through the shared formatters (`formatCurrency`, `parseCurrencyInput`); values render in mono font, sign- and type-colored per the baseline list styling (signed `expense`/`income`, neutral `transfer`, red/emerald at the balance level).
10. **RoundCurrency.** Every monetary computation on the server goes through `roundCurrency`; the frontend never invents its own rounding on currency display or accumulation.

## UX acceptance criteria

### Responsive

- **R1.** Layout is usable from ~360px phone width to wide desktop: balance cards stack to one column; the calendar reflows without horizontal scrolling; tables/lists collapse to stacked rows rather than truncating amounts.
- **R2.** Amounts never stabilize or clip on small screens — `min-w` is reserved for them instead of truncation (`text-overflow` is acceptable on titles, never on values).

### States

- **R3. Loading.** Initial forecast load and later refetches show skeletons for balance cards and chart; data fades in without layout jump. Tab switches show skeletons in the list area until `isLoadingRecent` clears.
- **R4. Error.** Forecast fetch failure renders a dedicated destructive alert with title and message — never a blank screen. Retry is possible by changing range/toggle (see R6). List failures surface per-list errors, toast + empty state, never a silent 200-shaped blank.
- **R5. Empty.** Each tab renders its own empty state: "no entries in this tab", including distinguishing no-pending from no-realized. Empty calendar (no data received) shows a friendly empty state with call-to-action to check the `ledger`.
- **R6. Staleness.** Range/simulation changes reuse the existing state; a new fetch reuses the page (spinner) without dropping the previous render. The `globalRefreshTrigger` from `useRefresh` continues to refresh forecast + tabs + finance base data as today.

### Amounts

- **R7.** Every currency shows the type-appropriate sign/color exactly as the baseline lists do (`+` income emerald, `-` expense red, neutral transfer zinc, projected balances red/green at the balance level).
- **R8.** The projection card label explicitly names the horizon (e.g. "Projeção (+30 dias)") — not just "balance".

### Calendar / trajectories

- **R9.** Every day in the fetched timeline shows its projected balance in its cell; days without data are visibly muted and never show a clickable promise or an invented balance.
- **R10.** Selecting a day (click or keyboard) yields the same day-details experience as clicking a chart point: named day (formatted), projected balance, and the day-deciding entries with badges, no truncation of numeric values.
- **R11.** Today is always visually distinct in the month containing it; no other day carries the today marking, and no muted day is ever highlighted as selected state.
- **R12.** The trajectory chart and the calendar are consistent views of the same data: for the same settings they agree day-by-day; clicking a chart point and selecting a calendar day of the same date open the same details.

### Shortcut flows

- **R13.** Quick entry is reachable from the dashboard in ≤1 interaction (existing modal is fine). Submission of any entry (real/simulated/scheduled) refreshes the dashboard immediately without reloading the page.
- **R14.** Realize is at most 2 interactions from the row (open menu, choose variant) and confirms with a distinct toast per variant.
- **R15.** Editing from a dashboard row opens the shared edit modal; cancel there must not refresh and must not mutate balances.
- **R16.** An invoice row action routes to the card module pre-scoped to the right card (`/cards?card_id=…`).
- **R17.** Navigation to `ledger`/`cards`/`management` is always available from the dashboard and shares the finance store's base data (canon §9 `loadBaseData`).

## Sprint / task breakdown

- **S1 — Calendar component.** Implemented `ForecastCalendar.vue` with month navigation, today marking, muted out-of-range days, keyboard selection, and daily balance previews. The calendar normalizes hydrated `Date` values as UTC day keys.
- **S2 — Page integration.** Implemented calendar selection → existing day details; chart and calendar share selected-day state. The page classifies the local today boundary consistently and distinguishes current versus projected balances.
- **S3 — States and responsiveness pass.** Added empty transaction states, visible transaction-fetch errors with retry, and mobile header wrapping. Browser smoke covered 360, 390, 768, 1280, and 1920px with no horizontal overflow.
- **S4 — Shortcut-flow tightening.** Added dashboard quick entry and finance-module shortcuts. Browser smoke exercised entry-modal opening, both realize choices and toasts, edit cancellation, and invoice routing with isolated API fixtures.
- **S5 — Semantic audit + documentation.** Updated canon and architecture maps. Remaining manual checklist items below still gate epic completion.

S1 and S2 are implemented. S3 and S4 have targeted browser smoke evidence. S5 remains open until the checklist is complete.

## Verification checklist

The checklist records remaining acceptance verification against the running app (hosted `docker compose up` or desktop `eb:dev`; canon §10). Items remain unchecked until observed in the target runtime; the epic stays in progress until all items pass.

- [ ] Balance card shows the current "Saldo disponível" amount (non-investment accounts only) and horizon-labeled "Projeção" amount with positive/negative colors (R7, R8; guardrail 1).
- [ ] Toggling "Simulação" changes the trajectory chart and simulated tab together, reverts cleanly, and does not change realized/pending lists (guardrail 2).
- [ ] Each realize variant produces a distinct toast; "silent" variant leaves balances untouched — verify balance card unchanged after the 2nd variant (guardrails 3, 5).
- [ ] A scheduled row shows the "Agendado" badge and does not offer realize menus (guardrail 3).
- [ ] A transfer row renders in neutral color and does not add to money totals (guardrail 4).
- [ ] Editing from a row opens the shared edit modal; cancel leaves balances and lists untouched; a real edit reflects in chart + calendar + lists after refetch (guardrail 6, R15, R6).
- [ ] An invoice row routes to the card module pre-scoped to that card and performs the payment there, not in this page (guardrail 7, R16).
- [ ] Balance card and calendar agree on "today's" balance for the same `includeSimulations` (guardrail 8).
- [ ] All amounts in lists, modal and calendar respect `formatCurrency` and mono/type coloring (R7, guardrail 9).
- [ ] Skeletons replace content during forecast load, then content appears with no layout jump (R3).
- [ ] Stopping the server produces the destructive alert (not a blank screen) on the main page; toggling range back recovers (R4, R6).
- [ ] Empty pending/realized/simulated tabs each show their specific empty copy (R5).
- [ ] Calendar shows projected balance for every day of the fetched timeline; muted for out-of-range days; overflow slots muted (R9, contract).
- [ ] Selecting a calendar day opens the day-details modal with the balance and entries impacting that date (R10, contract).
- [ ] Tab-navigating to the calendar grid and pressing Enter/Space on a day also selects that day and opens the details (contract, accessibility acceptance criterion).
- [ ] Previous/next month navigation works and only days with received forecast points show balances; today is visually marked in its month (calendar behavior).
- [ ] Chart point click and same-day calendar click open identical details (R12).
- [ ] Quick entry opens from the dashboard in ≤1 interaction; submissions refresh the dashboard data without a page reload (R13).
- [ ] Layout at every breakpoint: cards stack, calendar reflows, amounts never truncate (R1, R2).
- [ ] Realize flow ≤2 interactions from a row; edit reachable from the row (R14, R15).
- [ ] Nav from dashboard reaches `ledger` / `cards` / `management` and each shares the cached base data (R17; canon §9).

## Deliberately not included

- No server-side change: the calendar reuses the existing `/api/forecast` timeline; the balance cards reuse current store data. Any forecast-shape additions (per-day entries payload, precomputed day composition) belong to a later epic if needed; the current day details still derive client-side.
- No new use case, no new collection, no schema/migration change (canon §3 stays as-is).
- No `ledger` work (that surface is settled by E001), no cards/management redesign.
- No history file edit: canon `§1–§11`, ADRs, and `docs/handovers/` are inputs, not outcomes, of this epic unless a *new* decision is appended separately.
