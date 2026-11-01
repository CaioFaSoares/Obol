// Finance parity acceptance suite orchestration.
//
// One database, one deterministic serial case loop. Every case clears only the
// finance and sync-metadata collections in the guarded isolated database,
// installs its settled snapshot, runs the real use cases through the product
// unit of work, and compares PocketBase to the canonical fixture view.

import type PocketBase from 'pocketbase';

import { FinancialMutationRuntime } from '../../src/infrastructure/sync/FinancialMutationRuntime';
import {
  canonicalizeProjection,
  canonicalizeSnapshot,
  canonicalizeWhere,
  compareProjections,
  compareSnapshots,
  findUnresolvedCaptureTokens,
  resolveTokens,
} from './canonical';
import {
  canonicalizeCommandError,
  executeFixtureCommand,
  type CommandExecution,
  type CommandExecutionContext,
  type FaultState,
} from './commands';
import { loadFixtures, type FixtureLoadResult } from './fixtures';
import {
  EnvironmentGapError,
  IsolationRefusedError,
  clearFinancialAndSync,
  connectIsolatedPocketBase,
  displayDatasource,
  createSnapshotReader,
  describePbError,
  probeBatchAtomicity,
  readRuntimeConfig,
  redactSecrets,
  requireCollections,
  seedCase,
} from './pocketbase';
import { CommandTimeoutError } from './timeout';
import { ISOLATED_APP_NAME } from './types';
import type {
  CanonicalSnapshot,
  CanonicalizedError,
  CaseResult,
  ClockSpec,
  ExpectedError,
  FixtureCase,
  FixtureCommand,
  RawProjection,
  RawSnapshot,
  RuntimeConfig,
} from './types';
import type { SyncClock } from '../../src/domain/sync/MutationContext';

interface CaseDependencies {
  pb: PocketBase;
  runtime: FinancialMutationRuntime;
  readSnapshot: () => Promise<RawSnapshot>;
  config: RuntimeConfig;
}

function createCaseClock(spec: ClockSpec): SyncClock {
  // applied_at is receipt audit data only; it never seeds a financial date.
  const effective = spec.effective_at ?? spec.now;
  return { now: () => effective };
}

function formatExpectedError(error: ExpectedError): string {
  const entity = error.entity
    ? ` ${error.entity}${error.entity_id ? `:${error.entity_id}` : ''}`
    : '';
  return `${error.code}${entity}`;
}

function formatError(error: CanonicalizedError): string {
  const entity = error.entity
    ? ` ${error.entity}${error.entity_id ? `:${error.entity_id}` : ''}`
    : '';
  const detail = error.detail ? ` [${error.detail}]` : '';
  return `${error.code}${entity}${detail}`;
}

function compareExpectedError(
  expected: ExpectedError,
  actual: CanonicalizedError,
): string[] {
  const diffs: string[] = [];
  if (expected.code !== actual.code) {
    diffs.push(`error.code: expected "${expected.code}" actual "${actual.code}"`);
  }
  if (expected.entity !== undefined && expected.entity !== actual.entity) {
    diffs.push(
      `error.entity: expected "${expected.entity}" actual ${JSON.stringify(actual.entity ?? null)}`,
    );
  }
  if (expected.entity_id !== undefined && expected.entity_id !== actual.entity_id) {
    diffs.push(
      `error.entity_id: expected "${expected.entity_id}" actual ${JSON.stringify(actual.entity_id ?? null)}`,
    );
  }
  return diffs;
}

function resolveCaptures(
  command: FixtureCommand,
  captures: Map<string, string>,
  pre: CanonicalSnapshot,
  post: CanonicalSnapshot,
): string[] {
  if (!('capture' in command) || command.capture === undefined) return [];

  const problems: string[] = [];
  for (const [name, spec] of Object.entries(command.capture)) {
    try {
      const where = canonicalizeWhere(spec.where, spec.collection, 'expected');
      const preIds = new Set(pre[spec.collection].map((record) => record.id));
      const created = post[spec.collection].filter(
        (record) => !preIds.has(record.id),
      );
      const matches = created.filter((record) =>
        Object.entries(where).every(
          ([field, value]) => record[field] === value,
        ),
      );
      if (matches.length !== 1) {
        problems.push(
          `capture ${name}: expected exactly one new ${spec.collection} record, found ${matches.length}`,
        );
        continue;
      }
      captures.set(name, matches[0].id);
    } catch (error) {
      problems.push(
        `capture ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return problems;
}

function cleanupMessage(error: unknown): string {
  if (error instanceof CommandTimeoutError) {
    return `cleanup timed out after ${error.timeoutMs} ms`;
  }
  if (error instanceof EnvironmentGapError) return error.message;
  return `cleanup failed (${error instanceof Error ? error.name : typeof error})`;
}

async function runCase(
  file: string,
  fixtureCase: FixtureCase,
  dependencies: CaseDependencies,
): Promise<CaseResult> {
  const lines: string[] = [];
  let status: 'pass' | 'fail' = 'pass';
  let fatal: string | undefined;
  let cleanupFailure: string | undefined;

  const clock = createCaseClock(fixtureCase.clock);

  try {
    await clearFinancialAndSync(dependencies.pb, dependencies.config.ioTimeoutMs);
    await seedCase(
      dependencies.pb,
      dependencies.runtime.syncRepository,
      fixtureCase.initial,
      dependencies.config.ioTimeoutMs,
    );

    const seededRaw = await dependencies.readSnapshot();
    const seeded = canonicalizeSnapshot(seededRaw, 'actual');
    const expectedInitial = canonicalizeSnapshot(
      resolveTokens(fixtureCase.initial, new Map<string, string>()),
      'expected',
    );
    const seedDiffs = compareSnapshots(expectedInitial, seeded);

    if (seedDiffs.length > 0) {
      status = 'fail';
      lines.push('initial seeding mismatch:');
      lines.push(...seedDiffs);
    } else {
      let current = seeded;
      const captures = new Map<string, string>();
      const projections: RawProjection[] = [];
      let failure: CanonicalizedError | undefined;
      let faultCommand: FixtureCommand | undefined;
      let faultTriggered = false;
      let aborted = false;
      let failedCommandIndex: number | undefined;

      for (const [commandIndex, rawCommand] of fixtureCase.commands.entries()) {
        const command = resolveTokens(rawCommand, captures);
        const unresolved = findUnresolvedCaptureTokens(command, captures);
        if (unresolved.length > 0) {
          status = 'fail';
          lines.push(
            `unresolved capture token(s) in ${command.kind}: ${unresolved.join(', ')}`,
          );
          aborted = true;
          break;
        }

        if (command.fault) faultCommand = command;
        const faultState: FaultState = { triggered: false };
        const context: CommandExecutionContext = {
          runtime: dependencies.runtime,
          clock,
          timeoutMs: dependencies.config.commandTimeoutMs,
        };

        let execution: CommandExecution | undefined;
        try {
          execution = await executeFixtureCommand(command, context, faultState);
        } catch (error) {
          if (error instanceof CommandTimeoutError) {
            status = 'fail';
            fatal = `command ${command.kind} timed out after ${error.timeoutMs} ms`;
            lines.push(fatal);
            aborted = true;
            break;
          }
          failure = canonicalizeCommandError(error, command, current);
          failedCommandIndex = commandIndex;
        }
        faultTriggered = faultTriggered || faultState.triggered;

        // Read the commit result separately from the product error path: a
        // snapshot read failure is an environment failure, not a product
        // error to classify.
        const post = canonicalizeSnapshot(
          await dependencies.readSnapshot(),
          'actual',
        );

        if (execution !== undefined && failure === undefined) {
          if ('capture' in command && command.capture !== undefined) {
            const problems = resolveCaptures(command, captures, current, post);
            if (problems.length > 0) {
              status = 'fail';
              lines.push(...problems);
              current = post;
              aborted = true;
              break;
            }
          }

          if (execution.projection) projections.push(execution.projection);
        }
        current = post;
        if (failure !== undefined) break;
      }

      if (!aborted) {
        const expected = resolveTokens(fixtureCase.expect, captures);
        const diffs: string[] = [];

        if (expected.error) {
          if (!failure) {
            diffs.push(
              `error: expected ${formatExpectedError(expected.error)} but all commands completed successfully`,
            );
          } else {
            const errorDiffs = compareExpectedError(expected.error, failure);
            if (errorDiffs.length > 0) {
              diffs.push(
                `error: expected ${formatExpectedError(expected.error)}, got ${formatError(failure)}`,
              );
              diffs.push(...errorDiffs);
            }
          }
        } else if (failure) {
          diffs.push(`error: unexpected ${formatError(failure)}`);
        }

        if (
          failure &&
          failedCommandIndex !== undefined &&
          failedCommandIndex !== fixtureCase.commands.length - 1
        ) {
          diffs.push(
            `error occurred at command ${failedCommandIndex + 1} of ${fixtureCase.commands.length}; the fixture expects the last command to fail`,
          );
        }

        if (expected.snapshot) {
          try {
            const expectedSnapshot = canonicalizeSnapshot(
              expected.snapshot,
              'expected',
            );
            diffs.push(...compareSnapshots(expectedSnapshot, current));
          } catch (error) {
            diffs.push(
              `expected snapshot normalization failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (expected.projections) {
          try {
            const expectedProjections = expected.projections.map((projection) =>
              canonicalizeProjection(projection, 'expected'),
            );
            const actualProjections = projections.map((projection) =>
              canonicalizeProjection(projection, 'actual'),
            );
            diffs.push(...compareProjections(expectedProjections, actualProjections));
          } catch (error) {
            diffs.push(
              `projection normalization failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (faultCommand && !faultTriggered) {
          diffs.push(
            'declared storage fault did not trigger at the matched record-view write',
          );
        }

        if (diffs.length === 0) {
          status = 'pass';
          if (fixtureCase.known_blocker) {
            lines.push(
              `known_blocker: ${fixtureCase.known_blocker} did not reproduce`,
            );
          }
          if (fixtureCase.divergence) {
            lines.push(
              `divergence: ${fixtureCase.divergence.policy} satisfied by the current product`,
            );
          }
        } else {
          status = 'fail';
          lines.push(...diffs);
          if (fixtureCase.known_blocker) {
            lines.push(
              `known_blocker: ${fixtureCase.known_blocker} (informational only; expectation unchanged)`,
            );
          }
          if (fixtureCase.divergence) {
            lines.push(
              `divergence: ${fixtureCase.divergence.policy} (${fixtureCase.divergence.source}) — ${fixtureCase.divergence.note}`,
            );
          }
        }
      }
    }
  } catch (error) {
    status = 'fail';
    if (error instanceof CommandTimeoutError) {
      fatal = `case setup timed out in ${error.label} after ${error.timeoutMs} ms`;
    } else if (error instanceof EnvironmentGapError) {
      fatal = error.message;
    } else {
      fatal = redactSecrets(
        `case setup/read failure (${error instanceof Error ? error.name : typeof error}): ${error instanceof Error ? error.message : String(error)}${describePbError(error)}`,
        dependencies.config,
      );
    }
    lines.push(fatal);
  } finally {
    try {
      await clearFinancialAndSync(
        dependencies.pb,
        dependencies.config.ioTimeoutMs,
      );
    } catch (error) {
      cleanupFailure = cleanupMessage(error);
    }
  }

  if (cleanupFailure) {
    status = 'fail';
    fatal = cleanupFailure;
    lines.push(cleanupFailure);
  }

  return {
    file,
    id: fixtureCase.id,
    status,
    lines,
    ...(fatal ? { fatal } : {}),
  };
}

function printCaseResult(result: CaseResult): void {
  console.log(`${result.id}: ${result.status === 'pass' ? 'PASS' : 'FAIL'}`);
  for (const line of result.lines) {
    console.log(`  ${line}`);
  }
}

export async function runFinanceParitySuite(): Promise<number> {
  let config: RuntimeConfig;
  try {
    config = readRuntimeConfig(process.env);
  } catch (error) {
    if (error instanceof IsolationRefusedError) {
      console.error(`[parity] ${error.message}`);
      return error.exitCode;
    }
    console.error(
      `[parity] Could not read the runtime contract (${error instanceof Error ? error.name : typeof error}).`,
    );
    return 2;
  }

  console.log(`[parity] Datasource: ${displayDatasource(config.url)}`);

  let loaded: FixtureLoadResult;
  try {
    loaded = await loadFixtures(config.fixturesDir);
  } catch (error) {
    console.error(
      `[parity] Fixture contract error: ${redactSecrets(error instanceof Error ? error.message : String(error), config)}`,
    );
    return 1;
  }

  const expectedCaseCount = loaded.files.reduce(
    (total, file) => total + file.cases.length,
    0,
  );
  console.log(
    `[parity] Fixtures: ${expectedCaseCount} cases across ${loaded.files.length} files (${loaded.directory})`,
  );

  let pb: PocketBase;
  try {
    pb = await connectIsolatedPocketBase(config);
  } catch (error) {
    if (error instanceof IsolationRefusedError || error instanceof EnvironmentGapError) {
      console.error(`[parity] ${redactSecrets(error.message, config)}`);
      return error.exitCode;
    }
    console.error(
      `[parity] Could not connect to PocketBase (${error instanceof Error ? error.name : typeof error}).`,
    );
    return 3;
  }

  try {
    await requireCollections(pb, config.ioTimeoutMs);
    await clearFinancialAndSync(pb, config.ioTimeoutMs);
  } catch (error) {
    const message =
      error instanceof EnvironmentGapError
        ? error.message
        : `database preparation failed (${error instanceof Error ? error.name : typeof error})`;
    console.error(`[parity] ${redactSecrets(message, config)}`);
    return 3;
  }

  let probeResult: string;
  try {
    probeResult = await probeBatchAtomicity(pb, config.commandTimeoutMs);
  } catch (error) {
    const message =
      error instanceof EnvironmentGapError
        ? error.message
        : `batch probe failed (${error instanceof Error ? error.name : typeof error})`;
    console.error(`[parity] ${redactSecrets(message, config)}`);
    return 3;
  }

  console.log(`[parity] Isolation: meta.appName is exactly "${ISOLATED_APP_NAME}"`);
  console.log(`[parity] Batch probe: ${probeResult}`);
  console.log(
    '[parity] Seeding: exact fixture rows + obol_sync_meta/entity_versions in one PocketBase batch; the D5 boot backfill path is not exercised by this setup.',
  );
  console.log(
    '[parity] Faults: injected PocketBase 500 at the matched record-view write; UoW buffering/discard/commit stays product-owned.',
  );

  let runtime: FinancialMutationRuntime;
  let readSnapshot: () => Promise<RawSnapshot>;
  try {
    // Central role: web-origin mutations run through the product FIFO gate
    // and central journal. Initialization is skipped on purpose: the suite
    // seeds its own meta/versions and does not exercise the D5 backfill.
    runtime = new FinancialMutationRuntime(pb, { role: 'central' });
    readSnapshot = createSnapshotReader(pb, config.ioTimeoutMs);
  } catch (error) {
    console.error(
      `[parity] Could not build the product runtime (${error instanceof Error ? error.name : typeof error}).`,
    );
    return 3;
  }

  const results: CaseResult[] = [];

  for (const file of loaded.files) {
    for (const fixtureCase of file.cases) {
      // Every case starts by clearing and re-seeding the isolated dataset, and
      // a failed case cannot poison later ones: each case is attempted on the
      // freshly cleared database, so setup failures are reported per case.
      const result = await runCase(file.file, fixtureCase, {
        pb,
        runtime,
        readSnapshot,
        config,
      });
      results.push(result);
      printCaseResult(result);
    }
  }

  const failures = results.filter((result) => result.status === 'fail');
  const passed = results.length - failures.length;

  console.log('');
  console.log(
    `[parity] Summary: ${results.length} cases, ${passed} passed, ${failures.length} failed.`,
  );
  if (failures.length > 0) {
    console.log(
      `[parity] Failed: ${failures.map((result) => result.id).join(', ')}`,
    );
    return 1;
  }
  if (results.length !== expectedCaseCount) {
    console.log(
      `[parity] Incomplete run: expected ${expectedCaseCount} case results, produced ${results.length}.`,
    );
    return 1;
  }
  return 0;
}

/** Exposed for the entrypoint's top-level error boundary. */
export function describeUnexpectedError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
