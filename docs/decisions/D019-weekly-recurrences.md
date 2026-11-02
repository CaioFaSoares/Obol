# D019 - Weekly recurrence cadence

**Status**: accepted · **Date**: 2026-11-01 · **Target release**: 0.4.5 · **Related**: [D016](D016-native-offline-sync.md), canon [§3](../canon.md), [§6](../canon.md), [§7](../canon.md), [§14](../canon.md), [E008](../epics/E008-tuist-and-weekly-recurrences-045.md)

## Context

Canon §6 has exactly one cadence: monthly, anchored on `payday` (1 to 31) and clamped to the month length. The schema, the domain entity, the sync wire, the Swift model and the parity fixtures carry no frequency field, and period identity is `YYYY-MM` in generation, idempotency, `skipped_periods`, forecast iteration, card invoice projection and the prune window. E008 lists 17 product decisions that had to be fixed before code, because four independent implementations of the monthly rule already exist (server use cases, Swift `FinanceEngine`, Swift `ForecastEngine`, and the parity fixtures consumed by both).

## Decision

Two optional columns are added to `recurrences`; absent `frequency` reads as `monthly`, so every existing row keeps its meaning.

| Field | Type | Meaning |
|---|---|---|
| `frequency` | select `monthly` \| `weekly`, optional | Cadence. Absent or empty is `monthly`. |
| `weekday` | number 1 to 7, optional | ISO weekday, Monday = 1. Required when `frequency` is `weekly`; stored as `0` (the existing blank-number convention, as `total_installments` uses) for monthly rows. |

`payday` stays exactly what canon §3 says: the monthly day-of-month anchor, required, 1 to 31. It is not reinterpreted and it never drives a weekly occurrence.

### Occurrence identity and time

- Weeks are **UTC ISO weeks**: Monday 00:00 UTC to Sunday 23:59:59.999 UTC. Week identity never depends on a device timezone.
- The user chooses the `weekday`; it is never derived from the creation date.
- Monthly occurrence key stays `YYYY-MM`; weekly occurrence key is the occurrence date `YYYY-MM-DD`.
- Weekly dates are exact. There is no clamping for weekly rows, because 1 to 7 always exists in every week.
- `skipped_periods` stays one JSON array. Monthly entries remain `YYYY-MM`; weekly entries are `YYYY-MM-DD` occurrence keys. No second field is added.

### Generation

- The daily cron materializes the **current** period only: the current UTC month for monthly rows, the current UTC ISO week for weekly rows. The existing monthly behavior is unchanged.
- Idempotency for weekly rows matches a child whose `purchase_date` day, otherwise whose `expected_date` day, equals the occurrence day. Monthly rows keep the month match.
- A weekly recurrence created mid-week materializes the current week's occurrence on the next run even when that date precedes creation, exactly like a monthly recurrence created mid-month.
- Pause and resume never backfill missed periods. After resume only the current period generates.
- `end_date`, the installment bound and the skip key apply as before. `total_installments` counts weekly children as installments.
- Generated titles: monthly keeps `<name> - <M>/<year>` and `<name> - Parcela <n>/<N>`; weekly uses `<name> - <YYYY-MM-DD>` and the same installment form.
- A weekly card recurrence is supported: each occurrence is one child priced into the invoice whose due date covers that occurrence, so a monthly invoice may carry four or five weekly lines. This is the same additive invoice delta the monthly cadence already produces.

### Manual launch

- Monthly "lançar agora" still targets the next UTC month; weekly targets the occurrence of the **next** UTC ISO week.
- The replay carrier `targetPeriod` accepts `YYYY-MM` for monthly rows and `YYYY-MM-DD` for weekly rows. The sync executor derives it from the operation's `effectiveAt` so an offline launch keeps the week the user launched.

### Cadence changes

- `frequency` and `weekday` are patchable. Generated children are facts and are never rewritten.
- Idempotency stays per cadence. Switching weekly to monthly is naturally blocked for a month that already has a child, because the monthly match accepts any child in that month. Switching monthly to weekly may add weekly children in the current month; that is the cadence the user asked for, and the UI states it in the confirmation copy.

### Presentation

- The recurrence list and the details panel show the amount plus a cadence label (`Mensal — dia 5`, `Semanal — terça-feira`), never a bare day number with no cadence.
- Forecast and card projection keep per-occurrence amounts; there is no monthly-equivalent arithmetic on a weekly row.

### Compatibility

- `frequency` and `weekday` are optional additive fields in the snapshot, the wire validators and the Swift model. The sync `protocolVersion` stays 1.
- Clients ignore unknown response fields (canon §12), but the 0.4.0 server rejects unknown request and snapshot fields, so mixed 0.4.0 server with 0.4.5 client is not a supported combination; 0.4.5 ships the server and both clients together.
- `RECURRENCE_MONTH_EXISTS` keeps its name. Its meaning widens to "this recurrence already generated the occurrence period" for both cadences, so no client error table changes.

## Consequences

- One entity, one rule table, two cadence branches in six server use cases and the two Swift engines. No new collection, no new transaction field, no protocol bump.
- `skipped_periods` holds two key shapes. Every consumer that compares a key must first derive the key for the row's cadence; the prune window compares the month prefix of a weekly key.
- The SQLite store on iOS needs no migration: recurrence rows are JSON blobs decoded with `decodeIfPresent`.
- The migration is additive and optional, so a deployment that never creates a weekly recurrence stores the same `recurrence` rows as 0.4.0 plus two empty columns.

## Verification

- `server/test/weekly-recurrences.test.ts` covers generation, idempotency, skip keys, weekly launch, installments, card projection and the prune window.
- `shared/finance-parity/recurrences.json` and `forecast.json` carry the weekly cases, and both the TypeScript and the Swift consumers pass them (`server/test/finance-parity.integration.ts`, `swift test` under `app/ios`).
- Migration `1700000025_add_recurrence_frequency.js` is idempotent, aborts on an incompatible same-named field, and its down migration removes only the two fields.
