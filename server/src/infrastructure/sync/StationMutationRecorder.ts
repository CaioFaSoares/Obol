// Local-role durable intent recording (D016 D11/D13, canon §12.2/§12.5).
//
// Every financial mutation executed in `local` role is recorded as canonical
// user intents in `obol_station_outbox` inside the same atomic PocketBase
// batch as its finance rows and station-local revision rows. This recorder
// turns what actually happened — the executed use case (or the scheduler
// composition) plus the coalesced write set with its pre-write records — into
// complete `SyncOutboxOperation` descriptors:
//
// - a route intent records exactly ONE canonical operation: the operation the
//   user performed. Invoice routing, balance deltas, generated occurrences of
//   `recurrence.launch` and payment transactions of `invoice.pay` are
//   server-computed effects of that operation, never separate intents, and
//   `invoice.pay` for a partial payment is not split into amount-only
//   transactions;
// - a job intent records one real descriptor per canonical write the job
//   produced: scheduler months become `transaction.create` children that keep
//   their purchase-date input and `recurrence_id`, status/patch transitions
//   become the matching update descriptor, and deterministic server-side
//   repairs (invoice totals, orphan attachment) are never pseudo intents;
// - every descriptor carries a real pre-mutation snapshot and the last
//   server revision the device observed for its target. A locally created,
//   not-yet-accepted entity declares no base revision: the later push layer
//   may acquire the dependency-derived revision before the first send;
// - an operation that references a locally created and still unaccepted
//   relation (account, card, category, project, recurrence) declares that
//   pending operation in `dependsOn`, so a child is never frozen/sent before
//   its parent; a target entity with an unaccepted local create follows the
//   same rule;
// - the complete-envelope `payloadHash` covers exactly
//   `SYNC_ENVELOPE_HASH_FIELDS` and `dependsOn` is always an array, so the
//   stored row replays byte-identically after a crash.
//
// Payloads re-express user inputs from the operation table, never derived
// state: PB storage metadata never enters, blank storage forms are omitted
// from create payloads, and cleared relations/dates serialize as `null` on
// update. A card transaction carries `expected_date = purchase_date`, the
// purchase-date input the server DTO expects; a locally computed invoice due
// date is never sent as the operation date.

import { SYNC_PROTOCOL_VERSION, isSyncUuid } from '../../domain/sync/SyncProtocol';
import {
  SYNC_OPERATION_ENTITY_TYPES,
  type SyncEntitySnapshot,
  type SyncOutboxOperation,
  type SyncOperationType,
} from '../../domain/sync/SyncOperation';
import {
  isSyncEntityId,
  syncRevisionKey,
  type SyncEntityType,
  type SyncJsonObject,
  type SyncJsonValue,
  type SyncRecord,
} from '../../domain/sync/SyncRevision';
import { operationEnvelopeHash, toSyncJsonObject } from './CanonicalJson';
import { newOperationId } from './RecordIds';
import {
  type PocketbaseSyncRepository,
  type StationLocalVersionSnapshot,
} from '../repositories/PocketbaseSyncRepository';
import { MutationPreconditionError } from '../repositories/PocketbaseUnitOfWork';
import type {
  StationOutboxPlanContext,
  StationOutboxWriteContext,
} from './MutationCoordinator';

/** One executed use case of a job intent: token plus its exact arguments. */
export interface StationMutationUseCaseExecution {
  readonly token: string;
  readonly args: readonly unknown[];
}

/** Mutations recorded in local role: the intent plus the clock that drove it. */
export type StationMutationPlanIntent =
  | {
      readonly kind: 'useCase';
      readonly token: string;
      readonly args: readonly unknown[];
    }
  | {
      readonly kind: 'job';
      readonly useCases: readonly StationMutationUseCaseExecution[];
    }
  | {
      readonly kind: 'reset';
    };

/** Canonical operation type of every single-use-case route intent. */
const TOKEN_OPERATION_TYPES: Readonly<Record<string, SyncOperationType>> = {
  createTransactionUseCase: 'transaction.create',
  updateTransactionUseCase: 'transaction.update',
  deleteTransactionUseCase: 'transaction.delete',
  realizeTransactionUseCase: 'transaction.realize',
  createAccountUseCase: 'account.create',
  createCardUseCase: 'card.create',
  updateCardUseCase: 'card.update',
  payInvoiceUseCase: 'invoice.pay',
  deleteInvoiceUseCase: 'invoice.delete',
  createCategoryUseCase: 'category.create',
  createProjectUseCase: 'project.create',
  registerPaymentUseCase: 'project.payment',
  completeProjectUseCase: 'project.complete',
  createRecurrenceUseCase: 'recurrence.create',
  updateRecurrenceUseCase: 'recurrence.update',
  deleteRecurrenceUseCase: 'recurrence.delete',
  toggleRecurrenceStatusUseCase: 'recurrence.toggleStatus',
  launchRecurrenceUseCase: 'recurrence.launch',
};

/** Route intents that are backed by exactly one created write. */
const CREATE_OPERATION_TYPES: Readonly<Record<string, true>> = {
  'account.create': true,
  'card.create': true,
  'category.create': true,
  'project.create': true,
  'recurrence.create': true,
  'transaction.create': true,
};

/** Storage metadata excluded from canonical payloads. */
const PB_SYSTEM_KEYS: readonly string[] = [
  'id',
  'collectionId',
  'collectionName',
  'expand',
  'created',
  'updated',
];

/** Update-patch keys whose cleared storage blank maps to canonical null. */
const CLEARABLE_KEYS: readonly string[] = [
  'account_id',
  'card_id',
  'category_id',
  'project_id',
  'destination_account_id',
  'realized_date',
  'purchase_date',
  'end_date',
  'frequency',
  'total_installments',
];

/** Canonical create payload keys per entity type (the server assigns the rest). */
const CREATE_PAYLOAD_KEYS: Readonly<Record<SyncEntityType, readonly string[]>> = {
  account: ['name', 'type', 'initial_balance'],
  card: ['name', 'closing_day', 'due_day', 'limit'],
  category: ['name', 'type', 'monthly_budget'],
  project: ['name', 'total_value'],
  recurrence: [
    'name',
    'amount',
    'payday',
    'type',
    'frequency',
    'weekday',
    'account_id',
    'card_id',
    'category_id',
    'end_date',
    'total_installments',
    'skipped_periods',
  ],
  /**
   * `invoice_id` is server-computed routing and never part of an intent;
   * `recurrence_id` is the canonical create-only scheduler extension and
   * survives verbatim.
   */
  transaction: [
    'title',
    'amount',
    'type',
    'status',
    'expected_date',
    'realized_date',
    'purchase_date',
    'is_recurring',
    'is_silent',
    'is_simulated',
    'is_scheduled',
    'account_id',
    'card_id',
    'category_id',
    'project_id',
    'destination_account_id',
    'recurrence_id',
  ],
  invoice: [],
};

/** Operations whose payload is a canonical patch of an existing entity. */
type SyncUpdateOperationType =
  | 'card.update'
  | 'recurrence.update'
  | 'transaction.update';

/** Canonical update patch keys per entity type (the server owns the rest). */
const UPDATE_PAYLOAD_KEYS: Readonly<
  Record<'card' | 'recurrence' | 'transaction', readonly string[]>
> = {
  card: ['name', 'closing_day', 'due_day', 'limit'],
  // `status` is owned by toggle/launch/expiry, never by a generic patch.
  recurrence: [
    'name',
    'amount',
    'payday',
    'type',
    'frequency',
    'weekday',
    'account_id',
    'card_id',
    'category_id',
    'end_date',
    'total_installments',
    'skipped_periods',
  ],
  // `invoice_id` and `recurrence_id` are internal/create-only routing.
  transaction: [
    'title',
    'amount',
    'type',
    'status',
    'expected_date',
    'realized_date',
    'purchase_date',
    'is_recurring',
    'is_silent',
    'is_simulated',
    'is_scheduled',
    'account_id',
    'card_id',
    'category_id',
    'project_id',
    'destination_account_id',
  ],
};

/** Payload relation key -> entity type whose pending create must precede it. */
const RELATION_ENTITY_TYPES: Readonly<Record<string, SyncEntityType>> = {
  account_id: 'account',
  destination_account_id: 'account',
  card_id: 'card',
  category_id: 'category',
  project_id: 'project',
  recurrence_id: 'recurrence',
};

/**
 * Records canonical local intents into durable outbox descriptors. Constructed
 * once per runtime with the local `PocketbaseSyncRepository` (observed server
 * revisions and base records) and the durable station identity from
 * `obol_station_state` — the envelope `stationId` namespace.
 */
export class StationMutationRecorder {
  constructor(
    private readonly synchronizer: PocketbaseSyncRepository,
    private stationId: string | null,
  ) {}

  /**
   * Binds the durable station identity resolved by local `initialize()`.
   * Identity never changes after intents were recorded: a rebind is a
   * destructive reset, not a live swap.
   */
  setStationId(stationId: string | null): void {
    this.stationId = stationId;
  }

  /**
   * Builds the descriptor set for one recorded mutation inside the commit
   * plan. Throws `MutationPreconditionError` — aborting the commit with no
   * remote effect — when the intent is not recordable.
   */
  async planDescriptors(
    intent: StationMutationPlanIntent,
    context: StationOutboxPlanContext,
  ): Promise<readonly SyncOutboxOperation[]> {
    if (intent.kind === 'reset') {
      return [];
    }
    if (this.stationId === null || !isSyncUuid(this.stationId)) {
      throw new MutationPreconditionError(
        'The local runtime has no durable station identity; refusing to record an outbox intent',
      );
    }
    const at = context.clock.now();
    if (intent.kind === 'job') {
      return this.planJobDescriptors(context, at);
    }
    return this.planUserDescriptors(intent, context, at);
  }

  // -----------------------------------------------------------------------
  // Single-use-case route intents: exactly one canonical descriptor
  // -----------------------------------------------------------------------

  private async planUserDescriptors(
    intent: Extract<StationMutationPlanIntent, { kind: 'useCase' }>,
    context: StationOutboxPlanContext,
    at: string,
  ): Promise<readonly SyncOutboxOperation[]> {
    const operationType = TOKEN_OPERATION_TYPES[intent.token];
    if (operationType === undefined) {
      throw new MutationPreconditionError(
        `Route use case ${intent.token} has no canonical operation intent; refusing to commit an untracked local mutation`,
      );
    }

    const primary = this.primaryWrite(operationType, intent.args, context);
    const payload = this.payloadOf(operationType, primary, intent.args);
    if (isUpdateOperation(operationType) && Object.keys(payload).length === 0) {
      throw new MutationPreconditionError(
        `Route use case ${intent.token} changed no canonical update field`,
      );
    }
    const descriptor = await this.buildDescriptor(
      operationType,
      primary,
      payload,
      at,
      new Map(),
    );
    return [descriptor];
  }

  /**
   * Locates the write that backs the primary descriptor of one route intent.
   * Creates are matched by entity type, update/delete/complete paths by the
   * transport target id, and invoice operations by their invoice period.
   * `project.payment` and `recurrence.launch` never write the operation's
   * target row, so their descriptor identity comes from the first argument.
   */
  private primaryWrite(
    operationType: SyncOperationType,
    args: readonly unknown[],
    context: StationOutboxPlanContext,
  ): StationOutboxWriteContext {
    const entityType = SYNC_OPERATION_ENTITY_TYPES[operationType];

    if (operationType === 'project.payment' || operationType === 'recurrence.launch') {
      const targetId = args[0];
      if (typeof targetId !== 'string' || !isSyncEntityId(targetId)) {
        throw new MutationPreconditionError(
          `Route intent ${operationType} has no valid target entity id`,
        );
      }
      return {
        entityType,
        entityId: targetId,
        kind: 'upsert',
        existed: true,
        revision: 0,
        record: null,
        beforeRecord: null,
      };
    }

    const candidates = context.writes.filter((write) => write.entityType === entityType);

    if (CREATE_OPERATION_TYPES[operationType] === true) {
      const created = candidates.filter((write) => !write.existed);
      if (created.length !== 1) {
        throw new MutationPreconditionError(
          `Route intent ${operationType} needs exactly one create write, found ${created.length}`,
        );
      }
      return created[0]!;
    }

    if (operationType === 'invoice.pay') {
      const period = payPeriodOf(args);
      const byPeriod = candidates.filter(
        (write) => write.existed && write.record !== null && write.record['period'] === period,
      );
      if (byPeriod.length !== 1) {
        throw new MutationPreconditionError(
          `Route intent invoice.pay for period ${String(period)} needs exactly one invoice write, found ${byPeriod.length}`,
        );
      }
      return byPeriod[0]!;
    }

    if (operationType === 'invoice.delete') {
      const deleted = candidates.filter((write) => write.kind === 'delete');
      if (deleted.length !== 1) {
        throw new MutationPreconditionError(
          'Route intent invoice.delete needs exactly one invoice delete write',
        );
      }
      return deleted[0]!;
    }

    const targetId = args[0];
    if (typeof targetId !== 'string') {
      throw new MutationPreconditionError(
        `Route intent ${operationType} needs a string target id`,
      );
    }
    const matched = candidates.filter((write) => write.entityId === targetId);
    if (matched.length !== 1) {
      throw new MutationPreconditionError(
        `Route intent ${operationType} targets ${targetId} but the mutation wrote ${matched.length} matching writes`,
      );
    }
    return matched[0]!;
  }

  // -----------------------------------------------------------------------
  // Job intents: one real descriptor per canonical job write
  // -----------------------------------------------------------------------

  private async planJobDescriptors(
    context: StationOutboxPlanContext,
    at: string,
  ): Promise<readonly SyncOutboxOperation[]> {
    const descriptors: SyncOutboxOperation[] = [];
    /** Entities created in this same mutation, for causal child dependencies. */
    const createdInBatch = new Map<string, string>();

    for (const write of context.writes) {
      const operationType = jobOperationOf(write);
      if (operationType === null) {
        continue;
      }
      const payload = isUpdateOperation(operationType)
        ? this.updatePayloadOf(operationType, write)
        : operationType === 'transaction.create' ||
            operationType === 'card.create' ||
            operationType === 'recurrence.create'
          ? this.createPayloadOf(operationType, write)
          : {};
      if (isUpdateOperation(operationType) && Object.keys(payload).length === 0) {
        // Status-only transitions have no canonical patch carrier; the
        // server derives the identical transition deterministically.
        continue;
      }
      const descriptor = await this.buildDescriptor(
        operationType,
        write,
        payload,
        at,
        createdInBatch,
      );
      if (!write.existed) {
        createdInBatch.set(
          syncRevisionKey(write.entityType, write.entityId),
          descriptor.opId,
        );
      }
      descriptors.push(descriptor);
    }
    return descriptors;
  }

  // -----------------------------------------------------------------------
  // Descriptor assembly
  // -----------------------------------------------------------------------

  /**
   * Builds one complete frozen envelope. `at` is the single effective time of
   * the mutation (all descriptors of one job share it). Base revisions come
   * from the last accepted server revision; a locally created target declares
   * none and instead depends on its pending local create/send chain.
   */
  private async buildDescriptor(
    operationType: SyncOperationType,
    write: StationOutboxWriteContext,
    payload: SyncJsonObject,
    at: string,
    createdInBatch: ReadonlyMap<string, string>,
  ): Promise<SyncOutboxOperation> {
    const entityType = SYNC_OPERATION_ENTITY_TYPES[operationType];
    if (!isSyncEntityId(write.entityId)) {
      throw new MutationPreconditionError(
        `Canonical ${operationType} target id "${write.entityId}" is not a 15-character entity id`,
      );
    }
    const targetKey = syncRevisionKey(entityType, write.entityId);
    const localVersion = await this.readLocalVersion(entityType, write.entityId);

    const dependsOn = new Set<string>();
    const baseRevisions: Record<string, number> = {};

    if (write.existed) {
      const serverRevision = localVersion?.serverRevision ?? null;
      if (
        serverRevision !== null &&
        Number.isInteger(serverRevision) &&
        serverRevision >= 1
      ) {
        baseRevisions[targetKey] = serverRevision;
      } else {
        const pending = await this.pendingDependency(
          entityType,
          write.entityId,
          createdInBatch,
        );
        if (pending !== null) {
          dependsOn.add(pending);
        }
      }
    }

    // A canonical relation may point at an entity this device created but the
    // server has not accepted yet; the child must wait for that parent.
    for (const [field, relationType] of Object.entries(RELATION_ENTITY_TYPES)) {
      const value = payload[field];
      if (typeof value !== 'string' || !isSyncEntityId(value)) {
        continue;
      }
      const pending = await this.pendingDependency(relationType, value, createdInBatch);
      if (pending !== null) {
        dependsOn.add(pending);
      }
    }

    const beforeSnapshot = this.beforeSnapshot(entityType, write, localVersion);
    const opId = newOperationId();
    const envelope = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stationId: this.stationId!,
      opId,
      type: operationType,
      entityType,
      entityId: write.entityId,
      payload,
      baseRevisions,
      dependsOn: [...dependsOn].sort(),
      clientCreatedAt: at,
      effectiveAt: at,
    };
    const payloadHash = operationEnvelopeHash(envelope);
    // Structural construction cast: the operation table maps a runtime
    // operation type to the exact union member, and every field below is
    // present under its wire name. TypeScript cannot reduce the broad table
    // lookup to one discriminated member, so this single documented boundary
    // cast is required.
    return {
      ...envelope,
      payloadHash,
      status: 'queued',
      beforeSnapshots: [beforeSnapshot],
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    } as unknown as SyncOutboxOperation;
  }

  /** Pending local operation for one entity, if any (same-batch first). */
  private async pendingDependency(
    entityType: SyncEntityType,
    entityId: string,
    createdInBatch: ReadonlyMap<string, string>,
  ): Promise<string | null> {
    const batched = createdInBatch.get(syncRevisionKey(entityType, entityId));
    if (batched !== undefined) {
      return batched;
    }
    return await this.synchronizer.readUnacceptedStationOutboxForEntity(
      entityType,
      entityId,
    );
  }

  /** Pre-mutation snapshot of exactly one target entity. */
  private beforeSnapshot(
    entityType: SyncEntityType,
    write: StationOutboxWriteContext,
    localVersion: StationLocalVersionSnapshot | null,
  ): SyncEntitySnapshot {
    if (!write.existed) {
      return { entityType, entityId: write.entityId, revision: null, record: null };
    }
    // `beforeRecord` is the authoritative pre-write record. Targets a use case
    // reads but does not write (payment/launch) fall back to the pulled base.
    const record: SyncRecord | null =
      write.beforeRecord !== null
        ? write.beforeRecord
        : localVersion?.baseRecord ?? null;
    return {
      entityType,
      entityId: write.entityId,
      revision: localVersion?.serverRevision ?? null,
      record,
    };
  }

  private async readLocalVersion(
    entityType: SyncEntityType,
    entityId: string,
  ): Promise<StationLocalVersionSnapshot | null> {
    if (!isSyncEntityId(entityId)) {
      return null;
    }
    return await this.synchronizer.readStationLocalVersion(entityType, entityId);
  }

  // -----------------------------------------------------------------------
  // Payload assembly
  // -----------------------------------------------------------------------

  private payloadOf(
    operationType: SyncOperationType,
    write: StationOutboxWriteContext,
    args: readonly unknown[],
  ): SyncJsonObject {
    switch (operationType) {
      case 'transaction.realize':
        // The realization use case defaults a missing flag to true.
        return { update_balance: typeof args[1] === 'boolean' ? args[1] : true };
      case 'recurrence.toggleStatus': {
        const status = args[1];
        if (status !== 'active' && status !== 'paused') {
          throw new MutationPreconditionError(
            'Route intent recurrence.toggleStatus needs an "active"/"paused" argument',
          );
        }
        return { status };
      }
      case 'invoice.pay': {
        const input = payloadArgObjectOf(args[0], 'invoice.pay transport input');
        return toSyncJsonObject(
          {
            period: input['period'],
            account_id: input['accountId'],
            amount_paid: input['amountPaid'],
            ignore_balance: input['ignoreBalance'],
          },
          'canonical invoice.pay payload',
        );
      }
      case 'invoice.delete': {
        const cardId = args[0];
        const period = args[1];
        if (typeof cardId !== 'string' || typeof period !== 'string') {
          throw new MutationPreconditionError(
            'Route intent invoice.delete needs the card id and period arguments',
          );
        }
        return { card_id: cardId, period };
      }
      case 'project.payment': {
        const body = payloadArgObjectOf(args[1], 'project.payment transport payload');
        return toSyncJsonObject(
          { amount: body['amount'], description: body['description'] },
          'canonical project.payment payload',
        );
      }
      case 'project.complete':
      case 'recurrence.launch':
        return {};
      default:
        break;
    }
    if (isUpdateOperation(operationType)) {
      return this.updatePayloadOf(operationType, write);
    }
    return this.createPayloadOf(operationType, write);
  }

  /**
   * Update payload: canonical patch form of the actual change — a key rides
   * only when its stored value changed and the operation table allows it;
   * cleared relations/dates serialize as `null`.
   */
  private updatePayloadOf(
    operationType: SyncUpdateOperationType,
    write: StationOutboxWriteContext,
  ): SyncJsonObject {
    const entityType = SYNC_OPERATION_ENTITY_TYPES[operationType];
    const keys = UPDATE_PAYLOAD_KEYS[entityType];
    const after = write.record;
    if (after === null) {
      throw new MutationPreconditionError(
        'Update descriptors need the post-write record from the plan context',
      );
    }
    const before = write.beforeRecord === null ? {} : stripSystem(write.beforeRecord);
    const afterBody = stripSystem(after);
    // Mutable builder first; the returned `SyncJsonObject` is the immutable
    // domain value, so no readonly type is ever written through.
    const payload: Record<string, SyncJsonValue> = {};
    for (const key of keys) {
      if (before[key] === afterBody[key]) {
        continue;
      }
      const value = afterBody[key];
      if (key === 'total_installments' && value === 0) {
        payload[key] = null;
        continue;
      }
      // The weekly weekday is blank as `0` and the cadence as `""`; a cleared
      // canonical patch carries `null`, never a storage blank.
      if (key === 'weekday' && value === 0) {
        payload[key] = null;
        continue;
      }
      if (CLEARABLE_KEYS.includes(key) && (value === '' || value === undefined)) {
        payload[key] = null;
        continue;
      }
      if (value !== undefined) {
        payload[key] = value;
      }
    }
    return payload;
  }

  /**
   * Create payload per canonical allow list. System storage columns never
   * enter, blank storage forms are omitted (create stays null-free), and a
   * card transaction carries the purchase date as `expected_date`, exactly
   * the DTO input the server uses to recompute invoice routing.
   */
  private createPayloadOf(
    operationType: SyncOperationType,
    write: StationOutboxWriteContext,
  ): SyncJsonObject {
    const entityType = SYNC_OPERATION_ENTITY_TYPES[operationType];
    const keys = CREATE_PAYLOAD_KEYS[entityType];
    if (keys.length === 0) {
      throw new MutationPreconditionError(
        `Canonical ${operationType} is never built from a write set`,
      );
    }
    const record = write.record;
    if (record === null) {
      throw new MutationPreconditionError(
        `Canonical ${operationType} write carries no record to re-express`,
      );
    }
    const payload: Record<string, SyncJsonValue> = {};
    for (const key of keys) {
      const value = record[key];
      if (value === undefined || value === '') {
        continue;
      }
      // A create stays null-free and minimal: monthly is the default cadence,
      // and the blank weekday `0` is not a canonical value.
      if (key === 'frequency' && value !== 'weekly') continue;
      if (key === 'weekday' && !(typeof value === 'number' && value >= 1)) continue;
      payload[key] = value;
    }
    if (entityType === 'transaction' && typeof payload['card_id'] === 'string') {
      const purchaseDate = record['purchase_date'];
      if (typeof purchaseDate === 'string' && purchaseDate !== '') {
        payload['expected_date'] = purchaseDate;
      }
    }
    return payload;
  }
}

// ---------------------------------------------------------------------------
// Descriptor mapping tables and pure helpers
// ---------------------------------------------------------------------------

function isUpdateOperation(
  operationType: SyncOperationType,
): operationType is SyncUpdateOperationType {
  return (
    operationType === 'card.update' ||
    operationType === 'recurrence.update' ||
    operationType === 'transaction.update'
  );
}

/** Canonical job-level operation for one write, or null when non-canonical. */
function jobOperationOf(write: StationOutboxWriteContext): SyncOperationType | null {
  if (write.entityType === 'invoice' || write.entityType === 'account') {
    // Invoice rows and account balance deltas are server-computed effects of
    // the canonical fact that produced them, never separate intents.
    return null;
  }
  if (write.kind === 'delete') {
    if (write.entityType === 'transaction') return 'transaction.delete';
    if (write.entityType === 'recurrence') return 'recurrence.delete';
    return null;
  }
  if (!write.existed) {
    switch (write.entityType) {
      case 'card':
        return 'card.create';
      case 'recurrence':
        return 'recurrence.create';
      case 'transaction':
        return 'transaction.create';
      default:
        return null;
    }
  }
  switch (write.entityType) {
    case 'card':
      return 'card.update';
    case 'recurrence':
      return 'recurrence.update';
    case 'transaction':
      return 'transaction.update';
    default:
      return null;
  }
}

/** Pay period from the invoice.pay transport input object. */
function payPeriodOf(args: readonly unknown[]): string | null {
  const input = args[0];
  if (!isPayloadArgObject(input)) {
    return null;
  }
  const period = input['period'];
  return typeof period === 'string' ? period : null;
}

/** Reads one required object argument from the validated transport inputs. */
function payloadArgObjectOf(value: unknown, context: string): Record<string, unknown> {
  if (!isPayloadArgObject(value)) {
    throw new MutationPreconditionError(context);
  }
  return value;
}

/** Objects only: transport payloads are validated plain objects upstream. */
function isPayloadArgObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strips PB storage metadata and autodate columns from a record copy. */
function stripSystem(record: SyncRecord): SyncJsonObject {
  const copy: Record<string, SyncJsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (PB_SYSTEM_KEYS.includes(key)) {
      continue;
    }
    copy[key] = value;
  }
  return copy;
}
