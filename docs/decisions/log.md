# Decision log

One line per decision, newest first. Accepted decisions are never edited in merit - they are superseded by a new numbered decision.

| ID | Date | Decision | Status |
|---|---|---|---|
| D015 | 2026-10-29 | PocketBase 0.40.6 probe: migration 0011/0017 recorded, both session schemas and indexes present, no 0011 failure on fresh boot or follow-up; supersedes D013's expected two-boot error timeline | accepted |
| D014 | 2026-10-29 | Remote desktop and iOS WebView fetches require exact CORS origins (`views://mainview`, `capacitor://localhost`) when configured; same-origin web and no-Origin tools need none | accepted |
| D013 | 2026-10-29 | Runtime repair of the legacy `sessions` retry loop via additive migration 0017; ends the forever-failing 0011 sequence without touching it; supersedes D012's "0014-0016 complete migration startup" assumption | accepted |
| D012 | 2026-10-29 | Session records carry app-owned `createdAt` (migration 0016, fail-closed for legacy rows); D010's built-in-`sessions` causal claim is superseded, `obol_sessions` name stands | accepted |
| D011 | 2026-10-29 | Additive repair of `obol_sessions` fields via migration 0015 (`Collection.fields.add`); D010's registry name stands, only the repair method is superseded | accepted |
| D010 | 2026-10-29 | BFF session registry stored in `obol_sessions` (PocketBase reserved `sessions` collided); D009 contract unchanged | accepted |
| D009 | 2026-10-29 | Single-owner deployment; BFF-minted revocable sessions; Bearer + `__Host-` cookie contract | accepted |
| D008 | 2026-10-29 | Optional central server remains a shared remote runtime for desktop and iOS; one-owner identity is D009, exact WebView CORS is D014, and local desktop remains standalone | accepted |
| D007 | 2026-10-28 | Local profile unlock and non-destructive PocketBase superuser recovery | accepted |
| D006 | 2026-10-28 | Typed controller-to-use-case dispatch; keep explicit Elysia routes and Awilix classes | accepted |
| D005 | 2026-10-28 | Local Electrobun app: Nuxt SPA + in-process Elysia/RPC + pinned local PocketBase | accepted |
| D004 | 2026-10-28 | Docs as plain markdown; SilverBullet dropped; Copland house style | accepted |
| D003 | 2026-06-03 | Clean Architecture on the BFF (domain/application/infrastructure, awilix DI) | accepted |
| D002 | 2026-05-26 | Invoices as a first-class table; accrual `purchase_date`; installment auto-termination | accepted |
| D001 | 2026-05-22 | The Triad: Nuxt app + Elysia BFF + PocketBase, typed end-to-end via Eden Treaty | accepted |
