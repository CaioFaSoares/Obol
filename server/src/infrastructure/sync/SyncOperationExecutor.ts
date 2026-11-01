// Server-side push executor (E007 sync API slice).
//
// One `coordinator.runBatch` lease holds the FIFO gate for the whole ordered
// push batch while every operation still commits independently through the
// same coordinator path used by web/job/admin mutations. The executor is the
// only place the 18 D016 intent types are mapped to the existing financial use
// cases; no business rule is copied here beyond the sync-specific preflight
// checks D2/D4/D7 explicitly require:
//
// - idempotency first: a stored `opId` replays its original result, or is
//   rejected as `OP_ID_REUSED` when the envelope hash differs;
// - `dependsOn` must be accepted in this batch or already accepted by a
//   stored receipt, otherwise the operation is `blocked` and writes nothing;
// - a declared base revision for an entity the server has never seen is
//   `MISSING_ENTITY`;
// - a scheduler-generated `transaction.create` with `recurrence_id` is
//   validated against the actual recurrence and applies the §6 period
//   idempotency (monthly month or weekly occurrence day) before the use case
//   writes anything;
// - an invoice created/found by `SyncInvoiceUseCase` for a card purchase, a
//   card edit or a recurrence launch is the documented additive delta.
//
// The scoped container from `runtime.scopeFor(uow, clock)` runs the real use
// cases against one unit of work with the operation's `effectiveAt` clock.

import type { AwilixContainer } from 'awilix';
import { ClientResponseError } from 'pocketbase';

import type {
  AdditiveInvoiceDelta,
  MutationExecution,
  MutationOutcome,
} from './MutationCoordinator';
import type { FinancialMutationRuntime } from './FinancialMutationRuntime';
import { PocketbaseSyncProtocolRepository } from '../repositories/PocketbaseSyncProtocolRepository';
import {
  BufferedWriteConflictError,
  MutationCapacityExceededError,
  type PocketbaseUnitOfWork,
} from '../repositories/PocketbaseUnitOfWork';
import { resolveUseCase } from '../use-case-routes';
import type {
  SyncClock,
} from '../../domain/sync/MutationContext';
import type { Recurrence } from '../../domain/entities/Recurrence';
import type {
  SyncAppliedOperationResult,
  SyncOperationResult,
  SyncOperationWire,
} from '../../domain/sync/SyncOperation';
import {
  SYNC_COLLECTIONS,
  isSyncEntityId,
  parseSyncRevisionKey,
} from '../../domain/sync/SyncRevision';
import {
  SyncProtocolRequestError,
  isSyncUuidV7,
} from '../../domain/sync/SyncProtocol';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../domain/errors';
import {
  addUtcDays,
  addUtcMonths,
  calculateCardDueDate,
  calculateClampedDate,
  dayKey,
  daysInUtcMonth,
  isoWeekOccurrence,
  monthKey,
  startOfIsoWeek,
  startOfUtcMonth,
} from '../../domain/utils/dateUtils';
import type { RecurrenceCadence } from '../../domain/recurrence/cadence';
import type {
  SyncBatchResult,
  SyncPushBatch,
  SyncPushGateway,
} from '../../application/ports/sync/SyncPorts';
import type { InvoiceRepository } from '../../domain/interfaces/InvoiceRepository';

/** A per-operation preflight rejection that writes nothing. */
class SyncOperationRejected extends Error {
  constructor(
    readonly code:
      | 'INVALID_PAYLOAD'
      | 'MISSING_ENTITY'
      | 'ENTITY_ID_TAKEN'
      | 'RECURRENCE_MONTH_EXISTS',
    message: string,
  ) {
    super(message);
    this.name = 'SyncOperationRejected';
  }
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Patch semantics of a clearable text field, matching the use cases. */
function patchedText(
  stored: unknown,
  incoming: string | null | undefined,
): string | undefined {
  if (incoming === null) return undefined;
  if (incoming === undefined) return textOf(stored);
  return textOf(incoming);
}

/** Normalizes PocketBase's space-separated stored date for `new Date`. */
function dateValue(value: unknown): string | null {
  const text = textOf(value);
  return text === undefined ? null : text.replace(' ', 'T');
}

interface RecurrenceRowShape {
  readonly status: string;
  readonly payday: number;
  readonly frequency: RecurrenceCadence;
  /** ISO weekday 1..7; `undefined` for the stored blank `0` of a monthly row. */
  readonly weekday: number | undefined;
  readonly card_id: string | undefined;
  readonly skipped_periods: readonly string[];
  readonly total_installments: number;
  readonly end_date: string | null;
}

function recurrenceShape(row: Record<string, unknown>): RecurrenceRowShape {
  const payday = row['payday'];
  if (typeof payday !== 'number' || !Number.isInteger(payday)) {
    throw new Error('Stored recurrence payday is not an integer');
  }
  const frequency = textOf(row['frequency']);
  if (frequency !== undefined && frequency !== 'monthly' && frequency !== 'weekly') {
    throw new Error(`Stored recurrence frequency ${frequency} is not a cadence`);
  }
  const weekdayValue = row['weekday'];
  if (
    weekdayValue !== undefined &&
    weekdayValue !== null &&
    (typeof weekdayValue !== 'number' || !Number.isInteger(weekdayValue) || weekdayValue < 0 || weekdayValue > 7)
  ) {
    throw new Error('Stored recurrence weekday is not an ISO weekday');
  }
  const skipped = row['skipped_periods'];
  const skippedPeriods = Array.isArray(skipped)
    ? skipped.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const installments = row['total_installments'];
  return {
    status: String(row['status']),
    payday,
    frequency: frequency === 'weekly' ? 'weekly' : 'monthly',
    weekday: typeof weekdayValue === 'number' && weekdayValue >= 1 ? weekdayValue : undefined,
    card_id: textOf(row['card_id']),
    skipped_periods: skippedPeriods,
    total_installments:
      typeof installments === 'number' && Number.isInteger(installments)
        ? installments
        : 0,
    end_date: dateValue(row['end_date']),
  };
}

/**
 * A weekly recurrence without an ISO weekday is a stored invariant violation,
 * never a user input error: writes normalize the pair together.
 */
function recurrenceWeekday(recurrence: RecurrenceRowShape): number {
  if (recurrence.weekday === undefined) {
    throw new Error('Stored weekly recurrence carries no ISO weekday');
  }
  return recurrence.weekday;
}

/**
 * One push gateway: holds one lease for the ordered batch and executes every
 * operation with independent commits through the shared coordinator.
 */
export class SyncOperationExecutor implements SyncPushGateway {
  constructor(
    private readonly runtime: FinancialMutationRuntime,
    private readonly protocolRepository: PocketbaseSyncProtocolRepository,
  ) {}

  async push(batch: SyncPushBatch): Promise<SyncBatchResult> {
    const results = await this.runtime.coordinator.runBatch(async (lease) => {
      const accepted = new Set<string>();
      const receiptStatus = new Map<string, 'accepted' | 'conflict' | 'rejected'>();
      const collected: SyncOperationResult[] = [];

      for (const operation of batch.ops) {
        if (
          operation.stationId !== batch.stationId ||
          operation.protocolVersion !== batch.protocolVersion ||
          !isSyncEntityId(operation.entityId) ||
          !isSyncUuidV7(operation.opId) ||
          operation.dependsOn.some((dependency) => !isSyncUuidV7(dependency))
        ) {
          collected.push({
            opId: operation.opId,
            status: 'rejected',
            code: 'INVALID_PAYLOAD',
            message:
              'The operation identity disagrees with the push frame station/protocol or carries a non-canonical entity id.',
          });
          continue;
        }

        const existingReceipt =
          await this.runtime.syncRepository.readOperationReceipt(operation.opId);
        if (existingReceipt !== null) {
          // Let the coordinator resolve the stored receipt; its apply
          // callback is never invoked for a duplicate/rejected opId.
          const execution = await lease.run(
            this.mutationRequest(operation, null),
            async () => {
              throw new Error(
                'A stored operation receipt must never re-run the use case',
              );
            },
          );
          const result = this.resultOf(execution.outcome, operation);
          collected.push(result);
          if (result.status === 'applied' || result.status === 'duplicate') {
            accepted.add(operation.opId);
          }
          continue;
        }

        const blockedBy = await this.unacceptedDependencies(
          operation,
          accepted,
          receiptStatus,
        );
        if (blockedBy.length > 0) {
          collected.push({
            opId: operation.opId,
            status: 'blocked',
            code: 'DEPENDENCY_NOT_ACCEPTED',
            message: `Dependencies not accepted: ${blockedBy.join(', ')}.`,
            blockedBy,
          });
          continue;
        }

        let additiveInvoiceDelta: AdditiveInvoiceDelta | null = null;
        try {
          await this.assertDeclaredEntitiesExist(operation);
          if (operation.type === 'transaction.create') {
            const recurrenceId = operation.payload.recurrence_id;
            if (recurrenceId !== undefined) {
              await this.assertRecurrenceOccurrence(operation, recurrenceId);
            }
          }
          additiveInvoiceDelta =
            await this.resolveAdditiveInvoiceDelta(operation);
        } catch (error) {
          const rejection = this.knownRejection(error, operation);
          if (rejection === null) throw error;
          await this.recordFinalOutcome(operation, rejection);
          collected.push(rejection);
          continue;
        }

        const clock: SyncClock = {
          now: () => operation.effectiveAt,
        };
        let execution: MutationExecution<void>;
        try {
          execution = await lease.run(
            this.mutationRequest(operation, additiveInvoiceDelta, clock),
            async (unitOfWork) => {
              await this.assertTargetWritable(unitOfWork, operation);
              const scope = this.runtime.scopeFor(unitOfWork, clock);
              await this.applyOperation(scope, operation);
            },
          );
        } catch (error) {
          const rejection = this.knownRejection(error, operation);
          if (rejection === null) throw error;
          await this.recordFinalOutcome(operation, rejection);
          collected.push(rejection);
          continue;
        }

        const result = this.resultOf(execution.outcome, operation);
        await this.recordFinalOutcome(operation, result);
        collected.push(result);
        if (result.status === 'applied' || result.status === 'duplicate') {
          accepted.add(operation.opId);
        }
      }

      return collected;
    });

    const meta = await this.runtime.syncRepository.readSyncMeta();
    if (meta === null) {
      throw new Error(
        'obol_sync_meta is missing; the mutation runtime must initialize before serving sync',
      );
    }
    return {
      serverInstanceId: meta.serverInstanceId,
      dataEpoch: meta.dataEpoch,
      cursor: meta.lastSeq,
      results,
    };
  }

  private mutationRequest(
    operation: SyncOperationWire,
    additiveInvoiceDelta: AdditiveInvoiceDelta | null,
    clock?: SyncClock,
  ) {
    return {
      origin: 'sync' as const,
      stationId: operation.stationId,
      clock: clock ?? { now: () => operation.effectiveAt },
      operation,
      additiveInvoiceDelta,
    };
  }

  private async unacceptedDependencies(
    operation: SyncOperationWire,
    accepted: ReadonlySet<string>,
    receiptStatus: Map<string, 'accepted' | 'conflict' | 'rejected'>,
  ): Promise<readonly string[]> {
    const blocked: string[] = [];
    for (const dependency of operation.dependsOn) {
      if (accepted.has(dependency)) continue;
      let status = receiptStatus.get(dependency);
      if (status === undefined) {
        const receipt =
          await this.runtime.syncRepository.readOperationReceipt(dependency);
        status = receipt?.status;
        if (status !== undefined) {
          receiptStatus.set(dependency, status);
        }
      }
      if (status !== 'accepted') {
        blocked.push(dependency);
      }
    }
    return blocked;
  }

  /**
   * Authoritative id/state preflight inside the operation's own unit of work,
   * before any use case can touch a balance:
   *
   * - a create whose target id already has a version row (live or tombstone)
   *   is `ENTITY_ID_TAKEN`, and the finance row is checked in the same unit of
   *   work so an id that exists without a ledger row can never be overwritten;
   * - any other operation whose target is tombstoned has no finance row and is
   *   `MISSING_ENTITY`, never a store 404 that would escape as HTTP 500.
   */
  private async assertTargetWritable(
    unitOfWork: PocketbaseUnitOfWork,
    operation: SyncOperationWire,
  ): Promise<void> {
    const key = `${operation.entityType}:${operation.entityId}`;
    const creates = operation.type.endsWith('.create');
    const version = await this.runtime.syncRepository.readEntityVersion(
      operation.entityType,
      operation.entityId,
    );
    if (version !== null) {
      if (creates) {
        throw new SyncOperationRejected(
          'ENTITY_ID_TAKEN',
          `${key} already has a ${
            version.deleted ? 'tombstone' : 'live'
          } revision row; existing ids are never reused (D016 D6).`,
        );
      }
      if (version.deleted) {
        throw new SyncOperationRejected(
          'MISSING_ENTITY',
          `${key} is tombstoned; a deleted entity can never be updated.`,
        );
      }
      return;
    }
    if (!creates) {
      return;
    }
    const existing = await unitOfWork.preCommitRecord(
      SYNC_COLLECTIONS[operation.entityType],
      operation.entityId,
    );
    if (existing !== null) {
      throw new SyncOperationRejected(
        'ENTITY_ID_TAKEN',
        `${key} already exists in the finance store; existing ids are never reused (D016 D6).`,
      );
    }
  }

  /**
   * Every declared base revision must name an entity the version ledger knows
   * (including one created by an earlier accepted operation in this batch).
   */
  private async assertDeclaredEntitiesExist(
    operation: SyncOperationWire,
  ): Promise<void> {
    for (const key of Object.keys(operation.baseRevisions)) {
      const ref = parseSyncRevisionKey(key);
      if (ref === null) {
        throw new SyncOperationRejected(
          'INVALID_PAYLOAD',
          `baseRevisions key "${key}" is not a canonical entity key`,
        );
      }
      const version = await this.runtime.syncRepository.readEntityVersion(
        ref.entityType,
        ref.entityId,
      );
      if (version === null) {
        throw new SyncOperationRejected(
          'MISSING_ENTITY',
          `baseRevisions names ${ref.entityType}:${ref.entityId}, which has no server revision.`,
        );
      }
    }
  }

  /**
   * §6 recurrence rules for a linked generated occurrence: active recurrence,
   * clamped occurrence date, skipped period, installment bound and month
   * idempotency. Rejects before the create use case writes anything.
   */
  private async assertRecurrenceOccurrence(
    operation: Extract<SyncOperationWire, { type: 'transaction.create' }>,
    recurrenceId: string,
  ): Promise<void> {
    if (!isSyncEntityId(recurrenceId)) {
      throw new SyncOperationRejected(
        'INVALID_PAYLOAD',
        'recurrence_id must be a 15-character entity id.',
      );
    }
    const recurrenceRow = await this.protocolRepository.readFinanceRecord(
      'recurrence',
      recurrenceId,
    );
    if (recurrenceRow === null) {
      throw new SyncOperationRejected(
        'MISSING_ENTITY',
        `The recurrence ${recurrenceId} was not found.`,
      );
    }
    if (operation.payload.is_recurring !== true) {
      throw new SyncOperationRejected(
        'INVALID_PAYLOAD',
        'A transaction carrying recurrence_id must set is_recurring: true.',
      );
    }
    const recurrence = recurrenceShape(recurrenceRow);
    if (recurrence.status !== 'active') {
      throw new SyncOperationRejected(
        'INVALID_PAYLOAD',
        `The recurrence ${recurrenceId} is ${recurrence.status}; generated occurrences are only accepted for an active recurrence.`,
      );
    }

    const payload = operation.payload;
    const occurrenceDate = dateValue(payload.expected_date);
    if (occurrenceDate === null) {
      throw new SyncOperationRejected(
        'INVALID_PAYLOAD',
        'A generated occurrence needs a valid expected_date (its purchase date).',
      );
    }
    const weekly = recurrence.frequency === 'weekly';
    let period: string;
    if (weekly) {
      period = dayKey(isoWeekOccurrence(occurrenceDate, recurrenceWeekday(recurrence)));
      if (dayKey(occurrenceDate) !== period) {
        throw new SyncOperationRejected(
          'INVALID_PAYLOAD',
          `expected_date ${payload.expected_date} is not the weekday ${String(recurrence.weekday)} occurrence of its ISO week (${period}).`,
        );
      }
    } else {
      period = monthKey(occurrenceDate);
      const [year, monthNumber] = period.split('-').map(Number);
      const clamped = calculateClampedDate(
        year,
        monthNumber - 1,
        recurrence.payday,
        daysInUtcMonth(year, monthNumber - 1),
      );
      if (dayKey(occurrenceDate) !== dayKey(clamped)) {
        throw new SyncOperationRejected(
          'INVALID_PAYLOAD',
          `expected_date ${payload.expected_date} is not the clamped payday ${recurrence.payday} for ${period}.`,
        );
      }
    }
    if (recurrence.skipped_periods.includes(period)) {
      throw new SyncOperationRejected(
        'INVALID_PAYLOAD',
        `The recurrence ${recurrenceId} skips ${period}.`,
      );
    }
    if (
      recurrence.end_date !== null &&
      new Date(occurrenceDate) > new Date(recurrence.end_date)
    ) {
      throw new SyncOperationRejected(
        'INVALID_PAYLOAD',
        `The occurrence ${occurrenceDate} falls after the recurrence end date.`,
      );
    }

    const children = await this.protocolRepository.listTransactionsByRecurrence(
      recurrenceId,
    );
    if (
      recurrence.total_installments > 0 &&
      children.length + 1 > recurrence.total_installments
    ) {
      throw new SyncOperationRejected(
        'INVALID_PAYLOAD',
        `The recurrence ${recurrenceId} already generated ${String(children.length)} of ${String(recurrence.total_installments)} installments.`,
      );
    }

    for (const child of children) {
      const purchase = dateValue(child['purchase_date']);
      const expected = dateValue(child['expected_date']);
      let launched: boolean;
      if (weekly) {
        // A weekly child is keyed by the day of its purchase date, falling
        // back to its expected date.
        const reference = purchase ?? expected;
        launched = reference !== null && dayKey(reference) === period;
      } else {
        const purchaseMonth = purchase === null ? null : monthKey(purchase);
        const expectedMonth = expected === null ? null : monthKey(expected);
        launched = recurrence.card_id
          ? (purchaseMonth ?? expectedMonth) === period
          : purchaseMonth === period || expectedMonth === period;
      }
      if (launched) {
        throw new SyncOperationRejected(
          'RECURRENCE_MONTH_EXISTS',
          `The recurrence ${recurrenceId} already generated ${period}.`,
        );
      }
    }
  }

  /**
   * The only write-set exception: the invoice `SyncInvoiceUseCase` creates or
   * finds for a card purchase/edit or a recurrence launch. It is keyed by
   * `(card_id, period)`; a concurrent pay/delete declares its own revision and
   * still conflicts normally.
   */
  private async resolveAdditiveInvoiceDelta(
    operation: SyncOperationWire,
  ): Promise<AdditiveInvoiceDelta | null> {
    switch (operation.type) {
      case 'transaction.create': {
        const payload = operation.payload;
        if (
          !payload.card_id ||
          payload.type === 'transfer' ||
          payload.is_simulated === true
        ) {
          return null;
        }
        return await this.invoicePeriodFor(
          payload.card_id,
          payload.expected_date,
        );
      }
      case 'transaction.update': {
        const existing = await this.protocolRepository.readFinanceRecord(
          'transaction',
          operation.entityId,
        );
        if (existing === null) return null;
        const payload = operation.payload;
        const finalCardId = patchedText(existing['card_id'], payload.card_id);
        const finalType = payload.type ?? existing['type'];
        const simulated =
          payload.is_simulated ?? existing['is_simulated'] === true;
        if (!finalCardId || finalType === 'transfer' || simulated) return null;

        const storedCardId = textOf(existing['card_id']);
        const finalExpected =
          payload.expected_date ?? textOf(existing['expected_date']);
        const patchedPurchase = patchedText(
          existing['purchase_date'],
          payload.purchase_date,
        );
        // The edit form sends the purchase date in expected_date; the use
        // case mirrors that when the row is (or was) a card purchase.
        const purchaseDate =
          storedCardId !== undefined &&
          payload.purchase_date === undefined &&
          payload.expected_date !== undefined
            ? payload.expected_date
            : (patchedPurchase ?? finalExpected);
        if (purchaseDate === undefined) return null;
        return await this.invoicePeriodFor(finalCardId, purchaseDate);
      }
      case 'recurrence.launch': {
        const recurrenceRow = await this.protocolRepository.readFinanceRecord(
          'recurrence',
          operation.entityId,
        );
        if (recurrenceRow === null) return null;
        const recurrence = recurrenceShape(recurrenceRow);
        if (recurrence.card_id === undefined) return null;
        return await this.invoicePeriodFor(
          recurrence.card_id,
          this.launchOccurrence(recurrence, operation.effectiveAt),
        );
      }
      default:
        return null;
    }
  }

  private async invoicePeriodFor(
    cardId: string,
    purchaseDate: string,
  ): Promise<AdditiveInvoiceDelta | null> {
    const card = await this.protocolRepository.readFinanceRecord('card', cardId);
    if (card === null) return null;
    const closingDay = card['closing_day'];
    const dueDay = card['due_day'];
    if (typeof closingDay !== 'number' || typeof dueDay !== 'number') {
      throw new Error(`Stored card ${cardId} has non-numeric billing days`);
    }
    const dueDate = calculateCardDueDate(
      purchaseDate.replace(' ', 'T'),
      closingDay,
      dueDay,
    );
    return { cardId, period: monthKey(dueDate) };
  }

  /**
   * The period a launch targets for the recurrence's cadence: the next UTC
   * month (`YYYY-MM`) or the next ISO week's occurrence day (`YYYY-MM-DD`).
   * The launch use case receives exactly this value, so the replayed operation
   * and its additive invoice delta agree.
   */
  private targetLaunchPeriod(
    recurrence: RecurrenceRowShape,
    effectiveAt: string,
  ): string {
    if (recurrence.frequency === 'weekly') {
      const nextWeek = addUtcDays(startOfIsoWeek(effectiveAt), 7);
      return dayKey(isoWeekOccurrence(nextWeek, recurrenceWeekday(recurrence)));
    }
    return monthKey(addUtcMonths(startOfUtcMonth(effectiveAt), 1));
  }

  /** Exact occurrence instant of the launch target period. */
  private launchOccurrence(
    recurrence: RecurrenceRowShape,
    effectiveAt: string,
  ): string {
    const period = this.targetLaunchPeriod(recurrence, effectiveAt);
    if (recurrence.frequency === 'weekly') return `${period}T00:00:00.000Z`;
    const [year, monthNumber] = period.split('-').map(Number);
    return calculateClampedDate(
      year,
      monthNumber - 1,
      recurrence.payday,
      daysInUtcMonth(year, monthNumber - 1),
    );
  }

  // -----------------------------------------------------------------------
  // Intent -> real use case
  // -----------------------------------------------------------------------

  private async applyOperation(
    scope: AwilixContainer,
    operation: SyncOperationWire,
  ): Promise<unknown> {
    switch (operation.type) {
      case 'account.create':
        return await resolveUseCase(scope, 'createAccountUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });

      case 'card.create':
        return await resolveUseCase(scope, 'createCardUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });

      case 'card.update':
        return await resolveUseCase(scope, 'updateCardUseCase').execute(
          operation.entityId,
          operation.payload,
        );

      case 'category.create':
        return await resolveUseCase(scope, 'createCategoryUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });

      case 'project.create':
        return await resolveUseCase(scope, 'createProjectUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });

      case 'project.payment':
        return await resolveUseCase(scope, 'registerPaymentUseCase').execute(
          operation.entityId,
          operation.payload,
        );

      case 'project.complete':
        return await resolveUseCase(scope, 'completeProjectUseCase').execute(
          operation.entityId,
        );

      case 'recurrence.create': {
        // The wire payload keeps `skipped_periods` readonly; the recurrence
        // use case takes the stored, mutable entity shape.
        const { skipped_periods: skippedPeriods, ...fields } =
          operation.payload;
        const input: Partial<Recurrence> = {
          ...fields,
          id: operation.entityId,
          ...(skippedPeriods === undefined
            ? {}
            : { skipped_periods: [...skippedPeriods] }),
        };
        return await resolveUseCase(
          scope,
          'createRecurrenceUseCase',
        ).execute(input);
      }

      case 'recurrence.update':
        return await resolveUseCase(scope, 'updateRecurrenceUseCase').execute(
          operation.entityId,
          operation.payload,
        );

      case 'recurrence.delete':
        return await resolveUseCase(scope, 'deleteRecurrenceUseCase').execute(
          operation.entityId,
        );

      case 'recurrence.toggleStatus':
        return await resolveUseCase(
          scope,
          'toggleRecurrenceStatusUseCase',
        ).execute(operation.entityId, operation.payload.status);

      case 'recurrence.launch': {
        const recurrenceRow = await this.protocolRepository.readFinanceRecord(
          'recurrence',
          operation.entityId,
        );
        if (recurrenceRow === null) {
          throw new NotFoundError(
            `The recurrence ${operation.entityId} was not found.`,
          );
        }
        return await resolveUseCase(scope, 'launchRecurrenceUseCase').execute(
          operation.entityId,
          this.targetLaunchPeriod(
            recurrenceShape(recurrenceRow),
            operation.effectiveAt,
          ),
        );
      }

      case 'transaction.create':
        return await resolveUseCase(scope, 'createTransactionUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });

      case 'transaction.update':
        return await resolveUseCase(scope, 'updateTransactionUseCase').execute(
          operation.entityId,
          operation.payload,
        );

      case 'transaction.realize':
        return await resolveUseCase(scope, 'realizeTransactionUseCase').execute(
          operation.entityId,
          operation.payload,
        );

      case 'transaction.delete':
        return await resolveUseCase(scope, 'deleteTransactionUseCase').execute(
          operation.entityId,
        );

      case 'invoice.pay': {
        if (!/^\d{4}-\d{2}$/.test(operation.payload.period)) {
          throw new ValidationError('The invoice period must be YYYY-MM.');
        }
        const invoices = scope.resolve<InvoiceRepository>('invoiceRepository');
        const invoice = await invoices.findById(operation.entityId);
        if (invoice.period !== operation.payload.period) {
          throw new ValidationError(
            `Invoice ${operation.entityId} is period ${invoice.period}, not ${operation.payload.period}.`,
          );
        }
        return await resolveUseCase(scope, 'payInvoiceUseCase').execute({
          cardId: invoice.card_id,
          period: invoice.period,
          accountId: operation.payload.account_id,
          amountPaid: operation.payload.amount_paid,
          ignoreBalance: operation.payload.ignore_balance,
        });
      }

      case 'invoice.delete': {
        if (
          !isSyncEntityId(operation.payload.card_id) ||
          !/^\d{4}-\d{2}$/.test(operation.payload.period)
        ) {
          throw new ValidationError(
            'invoice.delete requires a canonical card id and a YYYY-MM period.',
          );
        }
        const invoices = scope.resolve<InvoiceRepository>('invoiceRepository');
        const invoice = await invoices.findByPeriodAndCard(
          operation.payload.card_id,
          operation.payload.period,
        );
        if (invoice === null) {
          throw new NotFoundError(
            `Invoice for period ${operation.payload.period} was not found.`,
          );
        }
        if (invoice.id !== operation.entityId) {
          throw new ValidationError(
            `Invoice ${operation.payload.card_id}/${operation.payload.period} is not ${operation.entityId}.`,
          );
        }
        return await resolveUseCase(scope, 'deleteInvoiceUseCase').execute(
          operation.payload.card_id,
          operation.payload.period,
        );
      }

      default: {
        const exhaustive: never = operation;
        throw new Error(`Unsupported operation ${String(exhaustive)}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Result mapping
  // -----------------------------------------------------------------------

  private resultOf(
    outcome: MutationOutcome,
    operation: SyncOperationWire,
  ): SyncOperationResult {
    switch (outcome.status) {
      case 'applied':
        return {
          opId: operation.opId,
          status: 'applied',
          entityVersions: outcome.entityVersions,
          entities: outcome.entities,
        };
      case 'duplicate': {
        const stored = outcome.storedResult as SyncAppliedOperationResult;
        return { ...stored, status: 'duplicate' };
      }
      case 'conflict':
        return {
          opId: operation.opId,
          status: 'conflict',
          code: 'SYNC_CONFLICT',
          conflicts: outcome.conflicts,
        };
      case 'rejected':
        return {
          opId: outcome.opId ?? operation.opId,
          status: 'rejected',
          code: outcome.code,
          message: outcome.message,
        };
      case 'deferred':
        throw new Error(
          'A top-level push operation can never defer without an outer mutation',
        );
    }
  }

  /**
   * A terminal rejection or conflict is final for its opId (D016 D2 rule 3):
   * the receipt is written so re-minting the opId with a different envelope is
   * `OP_ID_REUSED` instead of becoming applied later. Applied outcomes write
   * their receipt inside their commit, duplicates already have one, and a
   * tampered (`ENVELOPE_HASH_MISMATCH`) or already recorded (`OP_ID_REUSED`)
   * envelope must never be sealed as the final envelope of that opId.
   */
  private async recordFinalOutcome(
    operation: SyncOperationWire,
    result: SyncOperationResult,
  ): Promise<void> {
    if (result.status === 'conflict') {
      await this.runtime.coordinator.recordTerminalOutcome(operation, {
        status: 'conflict',
        conflicts: result.conflicts,
      });
      return;
    }
    if (result.status !== 'rejected') {
      return;
    }
    if (
      result.code === 'ENVELOPE_HASH_MISMATCH' ||
      result.code === 'OP_ID_REUSED'
    ) {
      return;
    }
    await this.runtime.coordinator.recordTerminalOutcome(operation, {
      status: 'rejected',
      code: result.code,
      message: result.message,
    });
  }

  /** Known domain/gate errors become per-operation rejections; anything else
   * is an unexpected structural fault and must not be reported as success. */
  private knownRejection(
    error: unknown,
    operation: SyncOperationWire,
  ): SyncOperationResult | null {
    if (error instanceof SyncOperationRejected) {
      return {
        opId: operation.opId,
        status: 'rejected',
        code: error.code,
        message: error.message,
      };
    }
    if (error instanceof NotFoundError) {
      return {
        opId: operation.opId,
        status: 'rejected',
        code: 'MISSING_ENTITY',
        message: error.message,
      };
    }
    // A repository point read of an absent row surfaces PocketBase's 404. That
    // is a per-operation `MISSING_ENTITY` (a deleted target, a relation that
    // names nothing), never an HTTP 500 that aborts the whole push batch.
    if (error instanceof ClientResponseError && error.status === 404) {
      return {
        opId: operation.opId,
        status: 'rejected',
        code: 'MISSING_ENTITY',
        message: error.message,
      };
    }
    if (error instanceof ConflictError) {
      return {
        opId: operation.opId,
        status: 'rejected',
        code:
          operation.type === 'recurrence.launch'
            ? 'RECURRENCE_MONTH_EXISTS'
            : 'INVALID_PAYLOAD',
        message: error.message,
      };
    }
    if (error instanceof ValidationError) {
      return {
        opId: operation.opId,
        status: 'rejected',
        code: 'INVALID_PAYLOAD',
        message: error.message,
      };
    }
    if (error instanceof BufferedWriteConflictError) {
      return {
        opId: operation.opId,
        status: 'rejected',
        code: 'ENTITY_ID_TAKEN',
        message: error.message,
      };
    }
    if (error instanceof MutationCapacityExceededError) {
      return {
        opId: operation.opId,
        status: 'rejected',
        code: 'COMMIT_TOO_LARGE',
        message: error.message,
      };
    }
    if (error instanceof SyncProtocolRequestError) {
      return {
        opId: operation.opId,
        status: 'rejected',
        code: 'INVALID_PAYLOAD',
        message: error.message,
      };
    }
    return null;
  }
}

/** Adapts the executor to the application `SyncPushGateway` port. */
export function createSyncPushGateway(
  runtime: FinancialMutationRuntime,
  protocolRepository?: PocketbaseSyncProtocolRepository,
): SyncPushGateway {
  return new SyncOperationExecutor(
    runtime,
    protocolRepository ??
      new PocketbaseSyncProtocolRepository(runtime.pb),
  );
}
