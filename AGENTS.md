# AGENTS.md

Rules for every agent working in this repo. Human-facing documentation lives in `docs/`.

## Language

Write everything in English: code, comments, commit messages, docs. Quoted source text and log lines stay verbatim.

## Evidence rules

- Never claim a fact without a path, URL, or the output of a command you ran.
- Claims about behavior come from reading or executing, never from stale docs. Docs in `docs/history/` describe the past; do not cite them as current truth.
- The numbered source of truth is `docs/canon.md`; decisions live in `docs/decisions/` (accepted ADRs are never edited in merit — supersede them).

## Where things live

| Subject | Home |
|---|---|
| Product definition, business rules, lifecycle | `docs/canon.md` (§-numbered) |
| Module map, layering, runtime topology | `docs/arquitetura.md` |
| Architecture decisions (ADRs) | `docs/decisions/D###-slug.md` + `log.md` |
| Epics (planned work) | `docs/epics/E###-slug.md` |
| Handover notes between sessions/agents | `docs/handovers/YYYY-MM-DD-slug.md` |
| Past reality | `docs/history/` (read-only archive) |
| Vocabulary | `CONTEXT.md` |
| Folder-level rules | `context.md` inside each top folder (`app/`, `server/`, `db/`, `desktop/`) |
| PocketBase schema changes | `db/pb_migrations/*.js` (never edit an applied migration; add a new one) |
| Server business rules | `server/src/application/use-cases/` |
| Persistence | `server/src/infrastructure/repositories/` only |
| HTTP shape and invocation | `server/src/infrastructure/controllers/` + `validators/`; `use-case-routes/` is the typed Awilix dispatch boundary (D006) |
| Frontend state | `app/stores/finance.ts` + `app/composables/` |
| Local desktop packaging/deploy | `desktop/` (`app.json`, `electrobun/`, `scripts/`; D005) |

## Workflow

- Structure moves are dedicated `refactor(repo):` commits, never mixed with feature work.
- Epics and their epics/sprints live in `docs/epics/`; work on code happens under a ticket/epic that names the files.
- State is derived, not declared: status lives in file location and frontmatter, never in index tables.

## May / may not

May: read anything, run the dev stack, write docs under `docs/`, edit code under `app/ server/ db/ desktop/`.

May not: edit an accepted ADR in merit; commit dumps or artifacts (`db_dump*.json`, `build/`, `dist/`); talk to PocketBase from the frontend; import PocketBase or Elysia inside `server/src/domain/` or `server/src/application/`; edit files under `docs/history/`; invent fields not in `docs/canon.md §3` without a migration + ADR.
