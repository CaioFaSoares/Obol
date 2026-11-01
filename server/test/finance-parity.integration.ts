// Explicit parity entrypoint. This file is intentionally not `*.test.ts`:
// the default `bun test` run must never require an external PocketBase. The
// parent invokes this file directly against the private isolated database.
//
// Contract: OBOL_PARITY_ISOLATED=1, POCKETBASE_URL, PB_ADMIN_EMAIL,
// PB_ADMIN_PASSWORD. Optional: OBOL_PARITY_FIXTURES_DIR,
// OBOL_PARITY_IO_TIMEOUT_MS, OBOL_PARITY_COMMAND_TIMEOUT_MS.

import {
  describeUnexpectedError,
  runFinanceParitySuite,
} from './finance-parity-support/runner';

try {
  process.exit(await runFinanceParitySuite());
} catch (error) {
  console.error(
    `[parity] Unexpected runner failure (${describeUnexpectedError(error)}).`,
  );
  process.exit(1);
}
