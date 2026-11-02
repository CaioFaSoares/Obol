// Explicit hosted sync protocol acceptance entrypoint.
//
// This file is intentionally NOT named `*.test.ts`: the default `bun test`
// run must never require an external BFF or PocketBase. The parent invokes it
// directly against the dedicated isolated Docker stack.
//
// Required environment:
//   OBOL_SYNC_ISOLATED=1
//   OBOL_SYNC_PB_URL=<private http(s) PocketBase URL>
//   OBOL_SYNC_BFF_URL=<private http(s) BFF URL>
//   OBOL_SYNC_PB_ADMIN_EMAIL / OBOL_SYNC_PB_ADMIN_PASSWORD
//   OBOL_SYNC_OWNER_EMAIL / OBOL_SYNC_OWNER_PASSWORD
// Optional:
//   OBOL_SYNC_SETUP_TOKEN (required only when the guarded server has no owner)
//   OBOL_SYNC_HTTP_TIMEOUT_MS / OBOL_SYNC_IO_TIMEOUT_MS
//
// The runner refuses every write unless PocketBase settings meta.appName is
// exactly "Obol sync protocol isolated".

import { runSyncProtocolSuite } from './sync-protocol-support/suite';

try {
  process.exit(await runSyncProtocolSuite());
} catch (error) {
  console.error(
    `[sync-acceptance] Unexpected runner failure (${error instanceof Error ? error.name : typeof error}).`,
  );
  process.exit(1);
}
