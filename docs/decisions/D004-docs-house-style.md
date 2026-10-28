# D004 - Docs as plain markdown, house style adopted

**Status**: accepted (2026-10-28, commit `ec88764`)

## Context
The SilverBullet docs container (`obol-docs`) served an index built from Obsidian-style queries that do not render outside that tool. Documentation was in pt-BR while the code and README are in English, and had drifted from the shipped architecture (written before the D003 refactor). Sibling projects (Nod, PACE, Tickety) converged on a plain-markdown house style.

## Decision
- Drop the SilverBullet service from both compose files; `docs/` is plain markdown versioned in git.
- Adopt the Copland house style: `docs/canon.md` as numbered source of truth, numbered ADRs in `docs/decisions/` (status in folder/frontmatter; superseded decisions are never edited in place), `docs/epics/`, `docs/handovers/`, stale docs demoted to `docs/history/`.
- English for all documentation. One fact, one home: no paragraph duplicated between docs; other docs link into `canon.md`.
- Agent-facing docs at repo root: `AGENTS.md` (charter + where-things-live table), `CLAUDE.md` (pointer to `AGENTS.md`), `CONTEXT.md` (glossary with avoid-list), plus per-folder `context.md`.

## Consequences
- Docs render anywhere (editor, GitHub, terminal).
- Obsolete content must be demoted to `history/` or rewritten, never silently left in place.
