# D014 - Explicit CORS origins for remote WebView clients

**Status**: accepted · **Date**: 2026-10-29 · **Target release**: 0.3.0 · **Related**: [D009](D009-remote-identity.md), [D013](D013-repair-legacy-sessions-migration.md), [E006](../epics/E006-central-server-mobile.md)

## Context

Remote desktop and iOS sessions use Bearer authentication, but their API calls originate in WebViews. Bearer authentication avoids cookie CSRF; it does not bypass browser CORS.

- The Electrobun main window loads `views://mainview/index.html` (`desktop/electrobun/bun/index.ts`). The shared client sends remote Bearer requests with `globalThis.fetch` from that renderer (`app/utils/api.ts`).
- The native iOS client sends API requests from WKWebView `fetch`, with origin `capacitor://localhost`.
- The BFF reflects only exact origins in `OBOL_CLIENT_ORIGINS`, answers preflight requests for those origins, and never enables wildcard CORS (`server/src/infrastructure/plugins/remoteAuth.ts`).
- A real BFF preflight probe for `Origin: views://mainview` returned no allow-origin response while only `capacitor://localhost` was configured. After adding `views://mainview`, preflight returned 204 with that exact allow-origin; the Bearer login returned 200. The `capacitor://localhost` preflight remained allowed, and an unrelated origin was not reflected.

## Decision

- Remote desktop deployments allowlist `views://mainview` in `OBOL_CLIENT_ORIGINS`.
- iOS deployments allowlist `capacitor://localhost`.
- A deployment serving both clients uses `OBOL_CLIENT_ORIGINS=views://mainview,capacitor://localhost`. Remove origins for clients that the server will not serve.
- Hosted web remains same-origin through the reverse proxy and needs no CORS entry. Requests without an `Origin` header, such as command-line operator requests, do not need an entry.
- Keep exact-origin matching. Never use `*`.

D014 supplements D009's Bearer/CORS policy. It does not change authentication, CSRF, or session contracts.

## Consequences

- A remote WebView can authenticate only when its origin is explicitly trusted by the server operator.
- Omitting an origin prevents browser JavaScript from reading responses even when the server accepts the Bearer credential; this is a configuration failure, not a reason to weaken the allowlist.
- The example self-host configuration includes both remote-client origins. Operators may remove unused entries.

## Verification and limits

- Verified against the real PocketBase-backed Compose BFF: exact preflights for `views://mainview` and `capacitor://localhost` returned 204 with matching `Access-Control-Allow-Origin`; an unrelated origin received no allow-origin header.
- The desktop source URL is `views://mainview/index.html`; the preflight probe supplied that serialized origin directly. The native desktop UI was not used to capture its actual request header.

## Related decisions

- [D009](D009-remote-identity.md) — Bearer identity, CORS allowlist, and same-origin hosted web.
- [D013](D013-repair-legacy-sessions-migration.md) — shared central server runtime remains `obol_sessions`-backed.
