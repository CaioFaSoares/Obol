# Handover — Obol as it is today (2026-10-28)

Audience: design work being done on top of the current system. Every fact below was verified against code on this date. Deeper truth: [`docs/canon.md`](../canon.md) (rules, §-numbered), [`docs/arquitetura.md`](../arquitetura.md) (modules), [`docs/decisions/log.md`](../decisions/log.md) (decisions), [`docs/epics/E001-ledger-electrobun.md`](../epics/E001-ledger-electrobun.md) (next work).

## 1. What Obol is

Personal cash-flow forecaster. Core idea: reconstruct past balances from realized transactions and project future balances day-by-day — pending items, card invoices, recurring rules — so the user sees the exact day cash runs out.

Current form: a web app running as three Docker containers (Nuxt :13000, Elysia BFF :13080, PocketBase :13090). Next form (planned, E001): a local desktop app via Electrobun, no server to deploy — one window, ~1100×720, local data. Design work should anticipate a **desktop window** surface, not a responsive web page.

## 2. Stack and hard constraints

- **Nuxt 3 + Nuxt UI v3 + Tailwind + ECharts + Pinia.** All UI components come from Nuxt UI (`UCard`, `UModal`, `UTable`, `UDropdown`, `UBadge`, `UToggle`, `USkeleton`, `UAlert`, `UPagination`); theme tokens live in `app/app.config.ts`.
- **The UI never talks to the database.** Every call goes through the typed BFF (Eden Treaty); the frontend shows what the backend computes. Business rules (invoice math, forecast, idempotency) are server-side and not negotiable from design.
- **End-to-end typing**: changing a backend field breaks the frontend build. Design can add screens freely, but field names come from `canon §3`.
- UI copy is pt-BR (user-facing); code/docs are English. Keep that split.

## 3. Visual language (as shipped)

| Element | Current treatment | Where |
|---|---|---|
| Background | `zinc-950` full-screen | `app/layouts/default.vue` |
| Cards | `bg-zinc-900`, `ring-1 ring-zinc-800`, rounded-xl | `app.config.ts` |
| Primary | `emerald`; gray scale `zinc` | `app.config.ts` |
| Top nav | Sticky, `zinc-900/80` + backdrop-blur, 14px height, icon+label links; active = `bg-zinc-700 text-white` | `layouts/default.vue` |
| Global FAB | Fixed bottom-right, 56px round emerald `+`, opens Fast Entry from anywhere | `layouts/default.vue` |
| Numbers | `font-mono`, 4xl on hero cards; income `+` emerald-400, expense `-` red-400, transfer zinc-500 | `pages/index.vue`, `pages/ledger.vue` |
| Simulated rows | Italic + purple-400 + purple `Simulado` badge | `ledger.vue` |
| Scheduled rows | Amber calendar icon + amber `Agendado` badge | `ledger.vue` |
| Status badges | Realized = emerald, Pending = yellow | `ledger.vue` |
| Modals | Dark overlay `zinc-950/75 backdrop-blur-sm`, `zinc-900` card body | `app.config.ts` |

No design-system layer exists yet: colors and treatments are inline Tailwind/Nuxt UI props, repeated per component. A design pass can either codify this into `app.config.ts`/tokens (Tickety's `apps/tokens` model) or replace it.

## 4. Screen inventory

### Global chrome (every screen)
Sticky top nav with 5 links: **Dashboard**, **Gestão** (`/management`), **Cartões** (`/cards`), **Auditoria** (`/ledger`), **Admin**. No mobile nav, no menu collapse. Floating `+` button opens **Fast Entry Modal** (unified quick entry: expense/income/transfer, account or card origin — card origin delegates the invoice math to the BFF). Global **Transaction Edit Modal** overlays any page. Mutations broadcast a global refresh; every screen refetches instantly (`composables/useRefresh.ts`).

### Dashboard `/` — "Dashboard de Projeção"
- Two hero cards: **Caixa Atual (Hoje)** and **Projeção (+N dias)** (N selectable 15/30/60/90 via dropdown; negative projection in red).
- **Trajetória do Saldo**: full-width ECharts line of the daily balance timeline; clickable day → detail modal.
- **Modo Simulação** toggle (purple) in the header; adds a third tab.
- Below: tabs **Realizados / Pendentes** (+ **Simulados**), paginated lists; card transactions excluded from the daily cashflow lists (they only hit the balance on invoice due date); pending tab merges open invoices as rows. Each pending row has a realize dropdown: *"Dar baixa e somar no saldo"* vs *"Já está no saldo (Baixa Silenciosa)"*.

### Auditoria `/ledger`
Full transaction table: date, title (+ badges), account/card name (resolves transfer as `src → dst`), status badge, signed amount, row action dropdown (edit / delete / *Efetivar* for simulations). Filter card with 5 selects: search (debounced 300ms), status, type, simulation isolation (Apenas Reais / Apenas Simulações / Misturado), scheduled isolation. Pagination 20/page. Design debt flagged in E001: no date-range or entity filters, no filtered-set totals, browser `confirm()` on delete, fixed sort, no export.

### Cartões `/cards`
Card selector → invoice month timeline → invoice body: due date, **em aberto / já pago / gasto bruto** (three numbers), status badge, **Pagar Fatura** / **Antecipar Pagamento**, purchase list including **projected rows** (recurrence-generated, shown as future purchases). Per-transaction menu: silent realize / edit / delete. This is the screen where the invoice engine's projection (§5) is visible to users.

### Gestão `/management`
Tab host: **Contas & Cartões** (`TabFinancial`), **Recorrências** (`TabRecurrences` + slideover details + pause/reactivate + "lançar agora"), **Orçamentos** (`TabBudgets`, progress bars green→yellow→red vs `monthly_budget`), **Projetos** (`TabProjects`, freela tracker with partial payments). Each opens its domain modal (Account/Card/Category/Budget/Project/Recurrence Modal).

### Admin `/admin`
Maintenance ops (invoice reconciliation etc.). Low design priority.

## 5. Interaction semantics design must respect

- **Transaction lifecycle** (`canon §4`): `pending → realized`, optional silent realize (no balance change), transfers are atomic src→dst. A simulated row can be converted to reality via the ledger modal (choose account/card; transfers need both ends).
- **Cards never debit daily cash on purchase** — only on invoice due date. Any design showing "current balance" must not blend credit spend into it; the dashboard explicitly excludes card transactions from lists.
- **Forecast is a daily loop** from the account snapshot, not a per-item widget — the chart and the hero number are the same computation.
- **Idempotent recurrences**: monthly rules generate facts; pausing, skipping and manual "lançar agora" are all safe (no duplicates ever). Skip semantics live in `skipped_periods`.
- **Budgets accrue on purchase**, not on payment.

## 6. Known UX debts (opportunity list)

1. Ledger gaps (E001 s01): totals, date-range, entity filters, export, modal delete, sort.
2. `confirm()`/`alert()`-style browser dialogs in flows that should be app modals.
3. Fetch errors mostly swallowed (`console.error`) — no consistent empty/error/loading state language beyond dashboard's `USkeleton` + `UAlert` pattern (that pattern is the precedent to extend).
4. No design-system layer; repeated inline styling.
5. No mobile/responsive audit (nav breaks below sm; original Front.md planned "Auditoria final de UX Mobile").
6. No login/security surface yet (future epic).
7. Desktop (E001): window-size-first layout, relative asset paths, no SSR.

## 7. How to run it for observation

```bash
nix develop
cp .env.example .env          # set PB_ADMIN_PASSWORD
cd app && npm install && cd ../server && bun install && cd ..
docker-compose up -d --build  # app :13000 · PB admin :13090/_/
```

Source of every screen: `app/pages/`, chrome in `app/layouts/default.vue`, global modals in `app/components/`.
