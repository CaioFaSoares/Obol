# E008 - Tuist evaluation and weekly recurrences (0.4.5)

**Status**: completed · **Target release**: 0.4.5 · **Completed**: 2026-11-01
**Related**: [D016](../decisions/D016-native-offline-sync.md) · [D018](../decisions/D018-zero-total-invoices.md) · canon [§3](../canon.md), [§6](../canon.md), [§7](../canon.md), [§13](../canon.md) · [E007](E007-native-offline-040.md)

> Both tracks landed in 0.4.5 as separate work streams. Tuist adoption was evaluated and deferred; the build-tooling corrections shipped. The weekly cadence shipped behind [D019](../decisions/D019-weekly-recurrences.md), which resolves every open product decision this epic listed.

## Goal

Two independent work streams, deliberately not merged into one sprint:

1. **iOS build tooling**: decide whether Obol adopts Tuist for `app/ios`, and land the cheap corrections that are worth doing regardless.
2. **Weekly recurrences**: extend the recurrence engine from "monthly only" to monthly plus weekly, across server, sync, web, desktop and iOS.

## Track 1 - Tuist for the iOS app

### Verdict: defer

Adopting Tuist now replaces one Xcode target and one scheme. The repository already avoids the usual reasons for a project generator:

- `app/ios/App/App.xcodeproj/project.pbxproj` is 392 lines with a single `App` target.
- `Features/` is a `PBXFileSystemSynchronizedRootGroup`, so new Swift files compile without touching the project file.
- Both Swift packages are local path references (`..` and `../ObolCore`) with no remote dependencies.
- `Core/` is compiled once by `ObolNativeRuntime`, not by the app target.

Cost to adopt: 18 to 24 engineer-hours, plus a rewrite of the two release scripts and the only iOS CI job that ships to TestFlight, all while the native cutover is still uncommitted.

### Cheap corrections worth doing now

| Item | Why | Effort | Result in 0.4.5 |
|---|---|---|---|
| Commit `app/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` | It is untracked; CI relies on Xcode's implicit scheme generation today | 15 min | committed |
| Delete `app/ios/debug.xcconfig` and its four `baseConfigurationReference` wirings | The file holds only comments; Release configurations point at a Debug xcconfig | 30 min | deleted; `project.pbxproj` has no `baseConfigurationReference` left |
| Add `xcodebuild -list` and `swift test` to the iOS workflow | The 51-test Swift parity suite has no CI job at all | 1 h | `.github/workflows/ios-swift-test.yml` runs both on every `app/ios` change |
| Fix `app/context.md` lines 13-14 | Still documents the Capacitor `ios:generate` / `ios:sync` flow | 15 min | `app/context.md` documents the native project and the parity suite |

### Re-evaluation trigger

Open a new decision when either happens: a second Xcode target lands in `app/ios` (UI-acceptance bundle, widget, share extension), or a second person edits `project.pbxproj` concurrently. Neither is true today.

## Track 2 - Weekly recurrences

### Today

One cadence exists: monthly, anchored on `payday` (1 to 31) clamped to the month length. There is no frequency, interval or weekday field in the schema, the domain entity, the sync wire, the Swift model or the parity fixtures. Period identity is `YYYY-MM` everywhere: generation, idempotency, `skipped_periods`, forecast iteration, card invoice projection and the prune window.

### Minimum schema change

Two optional columns on `recurrences`:

- `frequency`: select, `monthly` or `weekly`, optional, so existing rows read as monthly.
- `weekday`: number, 1 to 7 (ISO, Monday first), optional, meaningful only when `frequency` is weekly.

`skipped_periods` stays one JSON field: monthly entries keep the `YYYY-MM` form and weekly entries use `YYYY-MM-DD` occurrence keys.

Open schema gap found during the investigation: no migration adds `category_id` to `recurrences`, yet the entity, the DTO, the Nuxt modal and the Swift model all carry it. Verify against hosted PocketBase before the weekly migration lands, and fix it in the same file if confirmed.

### Code surface

Roughly 35 files across five layers, dominated by four independent implementations of the monthly rule:

| Layer | Files | Work |
|---|---|---|
| Server domain | 3 | Entity fields, UTC week helpers, sync payload and station protocol lists |
| Server use cases | 7 | Weekly generation and launch branch, forecast iteration, card invoice multi-line projection, skip-key handling in delete and prune |
| Server contracts | 6 | DTO validators, sync wire and snapshot validators, operation executor, mutation recorder, migration |
| Nuxt and desktop | 4 | Frequency and weekday controls, list and details copy |
| iOS | 10 | Models, finance engine, forecast engine, store, operation builder, editor and list |

The iOS SQLite store needs no migration: recurrence rows are JSON blobs decoded with `decodeIfPresent`.

### Product decisions (resolved in D019)

Every question below is answered by [D019](../decisions/D019-weekly-recurrences.md): ISO weekday chosen by the user, UTC ISO weeks, `payday` untouched, one array with both key shapes, one child per occurrence day, next-week manual launch, current-week materialization, no clamping, installments per child, cadence switch that never rewrites facts, weekly card children projected per invoice, cadence labels in the UI, occurrence-by-occurrence forecast, no backfill on resume, optional wire fields with protocol 1, and `RECURRENCE_MONTH_EXISTS` kept.

Original question list, kept for the record:

1. Weekday identity convention (ISO 1 to 7 versus Swift `Calendar`), and whether the user chooses the weekday or it derives from creation date.
2. Week anchored in UTC, and whether week identity may depend on device timezone.
3. Whether `payday` is reinterpreted for weekly rows or a separate weekday column carries the anchor.
4. Skip-key format: mixed month and day keys in one array, or a second field.
5. Idempotency unit: one child per day for weekly, and whether more than one child per month is allowed.
6. Meaning of "Launch now" for weekly: next calendar week, next ungenerated occurrence, or the current week even if past.
7. Materialization window: all weeks of the current month at once, the current week only, or current plus next.
8. First occurrence when a weekly recurrence is created mid-week.
9. Confirmation that clamping does not apply to weekly dates.
10. Whether `total_installments` counts weeks, and the title format for weekly children.
11. Cadence change on an existing recurrence that already generated monthly children.
12. Whether weekly card recurrences are supported (4 to 5 children per monthly invoice) or weekly is limited to account-based recurrences for the first release.
13. List and dashboard presentation: per-week amount, monthly equivalent, or a cadence badge.
14. Forecast horizon behaviour for 15, 30, 60 and 90 days with about 13 weekly occurrences in 90 days.
15. Pause and resume mid-cycle: whether missed weeks are backfilled.
16. Protocol compatibility for 0.4.x clients that reject unknown snapshot fields.
17. Whether `RECURRENCE_MONTH_EXISTS` is renamed or aliased.

### Effort

77 to 120 engineer-hours, about 10 to 15 engineer-days for one experienced engineer, excluding review and QA cycles. Limiting weekly to account-based recurrences removes the card projection work and saves 12 to 18 hours, at the cost of one deferred feature.

## Acceptance

Track 1 is done when the scheme is committed, the empty xcconfig is gone, CI runs `swift test`, and `app/context.md` matches the native project.

Track 2 is done when weekly recurrences generate, launch, forecast, project into card invoices, skip and resume with day-level idempotency, the six layers agree, and the parity fixtures cover the weekly cases for both the TypeScript and the Swift engines.

### Delivered evidence

| Gate | Evidence |
|---|---|
| Schema | `db/pb_migrations/1700000025_add_recurrence_frequency.js` applied on a fresh 0.40.6 database (`pocketbase migrate up`) |
| Server rules | `server/test/weekly-recurrences.test.ts` (21 tests) plus the full `bun test` run: 109 pass |
| Six layers agree | `shared/finance-parity/recurrences.json` (6 weekly cases), `forecast.json` (`fcst-weekly-occurrences`) and `invoices.json` (`inv-weekly-card-projection`) pass in the TypeScript suite (54/54) and in `swift test` (78 tests, 0 failures) |
| Sync contract | `server/test/sync-protocol.integration.ts` against an isolated stack: 54 cases, 54 pass, 0 unrun |
| Native build | `xcodebuild -project App/App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' build` → `BUILD SUCCEEDED` |
| Web build | `npm run build` in `app/` → build complete; `vue-tsc --noEmit` clean |
