// Authenticated sync HTTP controller (D016 D4, canon §12.3).
//
// `createSyncController(runtime)` returns the complete `/api/sync` Elysia
// plugin. The runtime owner mounts it after the D009 auth plugin, so every
// route inherits the existing cookie/Bearer session; there is no separate
// sync credential flow.
//
// Every handler reads the bounded raw request body itself and parses it once.
// That keeps the complete-envelope hash and the six-field import hash over the
// exact values the client sent, before Elysia schemas could coerce anything.
// Request-level protocol failures become the uniform `{ code, message }` body
// with the documented 409/413 status; a malformed JSON body is a 400
// `PAGE_INVALID`.

import { Elysia } from 'elysia';

import {
  SYNC_IMPORT_MAX_BYTES,
  SYNC_PUSH_MAX_BODY_BYTES,
  SYNC_SEED_MAX_BYTES,
  SyncProtocolRequestError,
  type SyncPushResponse,
} from '../../domain/sync/SyncProtocol';
import { systemSyncClock } from '../../domain/sync/MutationContext';
import type {
  SyncOperationResult,
  SyncOperationWire,
} from '../../domain/sync/SyncOperation';
import type { FinancialMutationRuntime } from '../sync/FinancialMutationRuntime';
import { createSyncPushGateway } from '../sync/SyncOperationExecutor';
import {
  PocketbaseSnapshotGateway,
  PocketbaseSyncProtocolRepository,
  PocketbaseSyncServerStateView,
  RuntimeSyncEventPageReader,
  RuntimeSyncStationRegistry,
} from '../repositories/PocketbaseSyncProtocolRepository';
import { SyncHandshakeUseCase } from '../../application/use-cases/sync/SyncHandshakeUseCase';
import { SyncImportUseCase } from '../../application/use-cases/sync/SyncImportUseCase';
import { SyncPullUseCase } from '../../application/use-cases/sync/SyncPullUseCase';
import { SyncPushUseCase } from '../../application/use-cases/sync/SyncPushUseCase';
import { SyncSeedUseCase } from '../../application/use-cases/sync/SyncSeedUseCase';
import {
  validateHandshakeFrame,
  validateOperationWire,
  validatePullQuery,
  validatePushFrame,
} from '../validators/SyncWireValidators';
import {
  validateImportFrame,
  validateSeedFrame,
} from '../validators/SyncSnapshotValidators';

const HANDSHAKE_MAX_BYTES = 64 * 1024;

/**
 * Elysia `set` surface used by the error mapper: the status option is
 * optional on the real context and accepts a numeric HTTP code or a named
 * status.
 */
interface SyncSet {
  status?: number | string;
}

function protocolFailure(set: SyncSet, error: SyncProtocolRequestError) {
  set.status = error.httpStatus;
  return { code: error.code, message: error.message };
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxBytes
  ) {
    throw new SyncProtocolRequestError(
      'REQUEST_TOO_LARGE',
      `The request body declares ${declaredLength} bytes; the bound is ${maxBytes}.`,
      413,
    );
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new SyncProtocolRequestError(
      'REQUEST_TOO_LARGE',
      `The request body is ${bytes.byteLength} bytes; the bound is ${maxBytes}.`,
      413,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      'The request body is not valid UTF-8.',
      400,
    );
  }
  if (text.trim().length === 0) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'The request body is empty.', 400);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      'The request body is not valid JSON.',
      400,
    );
  }
}

/**
 * Builds the authenticated sync surface around the shared financial mutation
 * runtime. The caller mounts the returned plugin after the D009 guard.
 */
export function createSyncController(runtime: FinancialMutationRuntime) {
  const protocolRepository = new PocketbaseSyncProtocolRepository(runtime.pb);
  const stateView = new PocketbaseSyncServerStateView(
    runtime.pb,
    runtime.syncRepository,
    runtime.serverName,
  );
  const stationRegistry = new RuntimeSyncStationRegistry(runtime);
  const pageReader = new RuntimeSyncEventPageReader(runtime, stateView);
  const pushGateway = createSyncPushGateway(runtime, protocolRepository);
  const snapshotGateway = new PocketbaseSnapshotGateway(
    runtime,
    protocolRepository,
  );

  const handshake = new SyncHandshakeUseCase(
    stateView,
    stationRegistry,
    systemSyncClock,
  );
  const push = new SyncPushUseCase(stateView, pushGateway);
  const pull = new SyncPullUseCase(stateView, pageReader);
  const seed = new SyncSeedUseCase(stateView, snapshotGateway);
  const importSnapshot = new SyncImportUseCase(stateView, snapshotGateway);

  return new Elysia({ prefix: '/api/sync' })
    .post('/handshake', async ({ request, set }) => {
      try {
        await runtime.initialize();
        const body = await readJsonBody(request, HANDSHAKE_MAX_BYTES);
        return await handshake.execute(validateHandshakeFrame(body));
      } catch (error) {
        if (error instanceof SyncProtocolRequestError) {
          return protocolFailure(set, error);
        }
        throw error;
      }
    })
    .post('/push', async ({ request, set }) => {
      try {
        await runtime.initialize();
        const body = await readJsonBody(request, SYNC_PUSH_MAX_BODY_BYTES);
        const frame = validatePushFrame(body);

        const results: SyncOperationResult[] = new Array(frame.ops.length);
        const validOps: SyncOperationWire[] = [];
        const validIndexes: number[] = [];
        frame.ops.forEach((raw, index) => {
          const validation = validateOperationWire(raw);
          if (validation.ok) {
            validOps.push(validation.op);
            validIndexes.push(index);
            return;
          }
          results[index] = {
            opId: validation.opId ?? '',
            status: 'rejected',
            code: validation.code,
            message: validation.message,
          };
        });

        const response: SyncPushResponse = await push.execute({
          protocolVersion: frame.protocolVersion,
          stationId: frame.stationId,
          serverInstanceId: frame.serverInstanceId,
          dataEpoch: frame.dataEpoch,
          ops: validOps,
        });
        if (response.results.length !== validOps.length) {
          throw new Error(
            'The push gateway returned a different number of results than operations',
          );
        }
        validIndexes.forEach((originalIndex, resultIndex) => {
          results[originalIndex] = response.results[resultIndex]!;
        });
        return {
          serverInstanceId: response.serverInstanceId,
          dataEpoch: response.dataEpoch,
          cursor: response.cursor,
          results,
        };
      } catch (error) {
        if (error instanceof SyncProtocolRequestError) {
          return protocolFailure(set, error);
        }
        throw error;
      }
    })
    .get('/pull', async ({ request, set }) => {
      try {
        await runtime.initialize();
        const url = new URL(request.url);
        return await pull.execute(
          validatePullQuery([...url.searchParams.entries()]),
        );
      } catch (error) {
        if (error instanceof SyncProtocolRequestError) {
          return protocolFailure(set, error);
        }
        throw error;
      }
    })
    .post('/seed', async ({ request, set }) => {
      try {
        await runtime.initialize();
        const body = await readJsonBody(request, SYNC_SEED_MAX_BYTES);
        return await seed.execute(validateSeedFrame(body));
      } catch (error) {
        if (error instanceof SyncProtocolRequestError) {
          return protocolFailure(set, error);
        }
        throw error;
      }
    })
    .post('/import', async ({ request, set }) => {
      try {
        await runtime.initialize();
        const body = await readJsonBody(request, SYNC_IMPORT_MAX_BYTES);
        return await importSnapshot.execute(validateImportFrame(body));
      } catch (error) {
        if (error instanceof SyncProtocolRequestError) {
          return protocolFailure(set, error);
        }
        throw error;
      }
    });
}
