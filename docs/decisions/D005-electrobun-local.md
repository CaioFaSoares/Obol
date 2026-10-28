# D005 - Local-first Electrobun packaging (Nod model)

**Status**: proposed (2026-10-28, epic E001)

## Context
Obol currently requires the Docker Triad (three containers) to run anywhere. The desired form is a local desktop app with no server to deploy, reusing the deploy system built for Nod (Electrobun 2.0.5, Bun main process, system webview, views bridge IPC, release workflow + Homebrew cask).

## Decision (proposed)
- Package Obol as an Electrobun desktop app: Nuxt SPA (`ssr: false`, `nuxi generate`) as the view, Elysia BFF running in the Electrobun Bun main process on `127.0.0.1:13080`, PocketBase as a supervised child process on `127.0.0.1:13090` with its data under the app data dir (`~/Library/Application Support/copland.obol`).
- Reuse Nod's scripts verbatim with renamed identity (`copland.obol`, `OBOL_*` env, `obol-<version>-macos-<arch>.zip` artifacts), including the release pipeline and Homebrew tap.
- Migrations continue to run on PocketBase boot; repositories are untouched (D003 payoff).
- v1 targets macOS only.

## Alternatives considered
- Embedded SQLite instead of PocketBase (Nod's `nod.db` style): rejected for v1 — rewrites all seven repositories and retests every rule for no local-run benefit.
- Keeping Docker locally: rejected — the point is zero-server local running.
- PocketBase HTTP server as in-process Elysia middleware: not viable — PocketBase is a separate Go binary.

## Consequences
- Two runtime modes coexist: desktop (Electrobun) and hosted (Docker/Coolify) — both must keep working; compose stays.
- New failure surfaces: child-process supervision, port collisions, PB binary distribution.
