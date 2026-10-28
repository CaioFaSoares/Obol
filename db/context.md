# db/ — PocketBase data layer

PocketBase v0.23+ with JS migrations executed on boot (`canon.md §10`).

| Path | Role |
|---|---|
| `pb_migrations/` | Versioned schema migrations; `1700000000_init_schema.js` creates base collections + `transactions` |
| `pb_data/` | Live SQLite data (gitignored, never committed) |

Rules: never edit an applied migration — add a new one with the next timestamp; every field added here must be reflected in `server/src/domain/entities/` and, when exposed, in validators + `docs/canon.md §3`; public API rules stay `null` (D001).
