// Command dispatch and error canonicalization.
//
// Every command runs inside the product MutationCoordinator gate and uses the
// runtime's scoped container bound to the unit-of-work record view. Only the
// declared storage fault is injected, at the matched record-view write; all
// buffering, discard and batch commit behavior remains the product's.

import type { AwilixContainer } from 'awilix';
import { ClientResponseError } from 'pocketbase';

import type { CreateAccountUseCase } from '../../src/application/use-cases/accounts/CreateAccountUseCase';
import type { CreateRecurrenceUseCase } from '../../src/application/use-cases/recurrences/CreateRecurrenceUseCase';
import type { LaunchRecurrenceUseCase } from '../../src/application/use-cases/recurrences/LaunchRecurrenceUseCase';
import type { ProcessMonthlyRecurrencesUseCase } from '../../src/application/use-cases/recurrences/ProcessMonthlyRecurrencesUseCase';
import type { ToggleRecurrenceStatusUseCase } from '../../src/application/use-cases/recurrences/ToggleRecurrenceStatusUseCase';
import type {
  GetCardInvoicesResponse,
  GetCardInvoicesUseCase,
} from '../../src/application/use-cases/cards/GetCardInvoicesUseCase';
import type { DeleteInvoiceUseCase } from '../../src/application/use-cases/cards/DeleteInvoiceUseCase';
import type { PayInvoiceUseCase } from '../../src/application/use-cases/cards/PayInvoiceUseCase';
import type { GetBudgetsUseCase } from '../../src/application/use-cases/categories/GetBudgetsUseCase';
import type { GenerateForecastUseCase } from '../../src/application/use-cases/forecast/GenerateForecastUseCase';
import type { CompleteProjectUseCase } from '../../src/application/use-cases/projects/CompleteProjectUseCase';
import type { ListProjectsUseCase } from '../../src/application/use-cases/projects/ListProjectsUseCase';
import type { RegisterPaymentUseCase } from '../../src/application/use-cases/projects/RegisterPaymentUseCase';
import type { CreateTransactionUseCase } from '../../src/application/use-cases/transactions/CreateTransactionUseCase';
import type { DeleteTransactionUseCase } from '../../src/application/use-cases/transactions/DeleteTransactionUseCase';
import type { RealizeTransactionUseCase } from '../../src/application/use-cases/transactions/RealizeTransactionUseCase';
import type { UpdateTransactionUseCase } from '../../src/application/use-cases/transactions/UpdateTransactionUseCase';
import type { Account } from '../../src/domain/entities/Account';
import type { Recurrence } from '../../src/domain/entities/Recurrence';
import type { Transaction } from '../../src/domain/entities/Transaction';
import { DomainError } from '../../src/domain/errors';
import type { SyncClock } from '../../src/domain/sync/MutationContext';
import type {
  BufferedPocketbaseCollection,
  PocketBaseViewLike,
  PocketbaseUnitOfWork,
  SyncListViewOptions,
} from '../../src/infrastructure/repositories/PocketbaseUnitOfWork';
import type { FinancialMutationRuntime } from '../../src/infrastructure/sync/FinancialMutationRuntime';
import type {
  MutationOutcome,
  MutationRequest,
} from '../../src/infrastructure/sync/MutationCoordinator';
import {
  isNegativeMoney,
  mapIntentRecord,
  normalizeInstant,
} from './canonical';
import {
  canonicalDecimal,
  compareDecimal,
  moneyToProductNumber,
  subtractDecimal,
} from './decimal';
import { withTimeout } from './timeout';
import type {
  CanonicalRecord,
  CanonicalSnapshot,
  CanonicalizedError,
  CollectionName,
  FaultSpec,
  FixtureCommand,
  RawBudgetsProjection,
  RawForecastProjection,
  RawInvoiceTimelineLine,
  RawInvoiceTimelineProjection,
  RawProjection,
  RawProjectsProjection,
} from './types';

export interface CommandExecutionContext {
  runtime: FinancialMutationRuntime;
  clock: SyncClock;
  timeoutMs: number;
}

export interface FaultState {
  triggered: boolean;
}

export interface CommandExecution {
  projection?: RawProjection;
}

interface DispatchResult {
  projection?: RawProjection;
}

export class CoordinatorOutcomeError extends Error {
  readonly outcome: string;
  readonly code: string;

  constructor(outcome: string, code: string) {
    super(`MutationCoordinator returned ${outcome}${code.length > 0 ? `:${code}` : ''}`);
    this.name = 'CoordinatorOutcomeError';
    this.outcome = outcome;
    this.code = code;
  }
}

export class InjectedStorageFailure extends ClientResponseError {
  readonly parityInjectedStorageFailure = true;

  constructor() {
    super({
      status: 500,
      url: '',
      response: { code: 500, message: 'Injected storage failure' },
      originalError: new Error('Injected storage failure'),
    });
    this.name = 'InjectedStorageFailure';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function outcomeCode(
  outcome: Exclude<MutationOutcome, { status: 'applied' }>,
): string {
  switch (outcome.status) {
    case 'rejected':
      return outcome.code;
    case 'conflict':
      return outcome.code;
    case 'duplicate':
      return 'DUPLICATE';
    case 'deferred':
      return 'DEFERRED';
    default:
      return '';
  }
}

/**
 * Wraps the unit-of-work record view so exactly the declared logical write
 * throws an SDK-shaped storage failure. The throw happens before the facade
 * buffers that write, so the product's own discard path rolls the command back.
 */
function createFaultView(
  view: PocketBaseViewLike,
  fault: FaultSpec,
  state: FaultState,
): PocketBaseViewLike {
  return {
    filter: (raw, params) => view.filter(raw, params),
    collection: (name) => {
      const inner = view.collection(name);
      const collectionName = name;

      const guard = (operation: 'update' | 'delete', recordId: string): void => {
        const target = fault.on_write;
        if (target.collection !== collectionName) return;
        if (target.operation !== undefined && target.operation !== operation) return;
        if (target.record_id !== undefined && recordId !== target.record_id) {
          return;
        }
        state.triggered = true;
        throw new InjectedStorageFailure();
      };

      const facade: BufferedPocketbaseCollection = {
        getOne: <T = unknown>(id: string) => inner.getOne<T>(id),
        getFirstListItem: <T = unknown>(filter: string) =>
          inner.getFirstListItem<T>(filter),
        getList: <T = unknown>(
          page: number,
          perPage: number,
          options: SyncListViewOptions | undefined,
        ) => inner.getList<T>(page, perPage, options),
        getFullList: <T = unknown>(options: SyncListViewOptions | undefined) =>
          inner.getFullList<T>(options),
        create: async <T = unknown>(data: Record<string, unknown>) => {
          const target = fault.on_write;
          const matchesCreate =
            target.collection === collectionName &&
            (target.operation === undefined || target.operation === 'create');
          if (matchesCreate && target.record_id === undefined) {
            state.triggered = true;
            throw new InjectedStorageFailure();
          }

          const created = await inner.create<T>(data);
          if (matchesCreate && target.record_id !== undefined) {
            const createdId =
              typeof created === 'object' &&
              created !== null &&
              'id' in created &&
              typeof created.id === 'string'
                ? created.id
                : undefined;
            if (createdId === target.record_id) {
              state.triggered = true;
              throw new InjectedStorageFailure();
            }
          }
          return created;
        },
        update: <T = unknown>(id: string, data: Record<string, unknown>) => {
          guard('update', id);
          return inner.update<T>(id, data);
        },
        delete: (id: string) => {
          guard('delete', id);
          return inner.delete(id);
        },
      };
      return facade;
    },
  };
}

/**
 * The runtime scopes repositories from `unitOfWork.view()`. Fault injection
 * must not replace the real unit of work (the coordinator still owns commit,
 * rollback and the FIFO gate), so only that view accessor is overridden.
 */
function unitOfWorkWithFaultView(
  unitOfWork: PocketbaseUnitOfWork,
  view: PocketBaseViewLike,
): PocketbaseUnitOfWork {
  return new Proxy(unitOfWork, {
    get(target, property) {
      if (property === 'view') return () => view;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function executeFixtureCommand(
  command: FixtureCommand,
  context: CommandExecutionContext,
  faultState: FaultState,
): Promise<CommandExecution> {
  const request: MutationRequest = {
    origin: 'web',
    stationId: null,
    clock: context.clock,
    operation: null,
  };

  const execution = await withTimeout(
    context.runtime.coordinator.run(request, async (unitOfWork) => {
      const scopedUnitOfWork = command.fault
        ? unitOfWorkWithFaultView(
            unitOfWork,
            createFaultView(unitOfWork.view(), command.fault, faultState),
          )
        : unitOfWork;
      const scope = context.runtime.scopeFor(scopedUnitOfWork, context.clock);
      return dispatchCommand(command, scope, context.clock);
    }),
    context.timeoutMs,
    command.kind,
  );

  if (execution.outcome.status !== 'applied') {
    throw new CoordinatorOutcomeError(
      execution.outcome.status,
      outcomeCode(execution.outcome),
    );
  }

  return execution.result ?? {};
}

/** Adapter boundary: the fixture validator already checked every mapped field. */
function productIntent<T>(record: Record<string, unknown>, collection: CollectionName): T {
  return mapIntentRecord(record, collection) as unknown as T;
}

function dispatchCommand(
  command: FixtureCommand,
  scope: AwilixContainer,
  clock: SyncClock,
): Promise<DispatchResult> {
  switch (command.kind) {
    case 'account.create':
      return dispatchAccountCreate(command, scope);
    case 'transaction.create':
      return dispatchTransactionCreate(command, scope);
    case 'transaction.update':
      return dispatchTransactionUpdate(command, scope);
    case 'transaction.realize':
      return dispatchTransactionRealize(command, scope);
    case 'transaction.delete':
      return dispatchTransactionDelete(command, scope);
    case 'transaction.set_simulated':
      return dispatchTransactionSetSimulated(command, scope);
    case 'invoice.pay':
      return dispatchInvoicePay(command, scope);
    case 'invoice.delete':
      return dispatchInvoiceDelete(command, scope);
    case 'invoice.summaries':
      return dispatchInvoiceSummaries(command, scope);
    case 'recurrence.create':
      return dispatchRecurrenceCreate(command, scope);
    case 'recurrence.set_status':
      return dispatchRecurrenceSetStatus(command, scope);
    case 'recurrence.launch':
      return dispatchRecurrenceLaunch(command, scope);
    case 'recurrence.process_month':
      return dispatchRecurrenceProcessMonth(command, scope);
    case 'forecast.generate':
      return dispatchForecastGenerate(command, scope);
    case 'budget.summaries':
      return dispatchBudgetSummaries(command, scope, clock);
    case 'project.payment':
      return dispatchProjectPayment(command, scope);
    case 'project.complete':
      return dispatchProjectComplete(command, scope);
    case 'project.summaries':
      return dispatchProjectSummaries(command, scope);
    default: {
      const exhaustive: never = command;
      void exhaustive;
      return Promise.reject(new Error('Unsupported fixture command'));
    }
  }
}

async function dispatchAccountCreate(
  command: Extract<FixtureCommand, { kind: 'account.create' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<CreateAccountUseCase>('createAccountUseCase');
  await useCase.execute(productIntent<Partial<Account>>(command.record, 'accounts'));
  return {};
}

async function dispatchTransactionCreate(
  command: Extract<FixtureCommand, { kind: 'transaction.create' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<CreateTransactionUseCase>('createTransactionUseCase');
  await useCase.execute(
    productIntent<Partial<Transaction>>(command.record, 'transactions'),
  );
  return {};
}

async function dispatchTransactionUpdate(
  command: Extract<FixtureCommand, { kind: 'transaction.update' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<UpdateTransactionUseCase>('updateTransactionUseCase');
  await useCase.execute(
    command.id,
    productIntent<Partial<Transaction>>(command.patch, 'transactions'),
  );
  return {};
}

async function dispatchTransactionRealize(
  command: Extract<FixtureCommand, { kind: 'transaction.realize' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<RealizeTransactionUseCase>('realizeTransactionUseCase');
  await useCase.execute(command.id, { update_balance: command.update_balance });
  return {};
}

async function dispatchTransactionDelete(
  command: Extract<FixtureCommand, { kind: 'transaction.delete' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<DeleteTransactionUseCase>('deleteTransactionUseCase');
  await useCase.execute(command.id);
  return {};
}

async function dispatchTransactionSetSimulated(
  command: Extract<FixtureCommand, { kind: 'transaction.set_simulated' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<UpdateTransactionUseCase>('updateTransactionUseCase');
  await useCase.execute(command.id, { is_simulated: command.is_simulated });
  return {};
}

async function dispatchInvoicePay(
  command: Extract<FixtureCommand, { kind: 'invoice.pay' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<PayInvoiceUseCase>('payInvoiceUseCase');
  await useCase.execute({
    cardId: command.card_id,
    period: command.period,
    accountId: command.account_id,
    amountPaid:
      command.amount_paid === undefined
        ? undefined
        : moneyToProductNumber(command.amount_paid),
    ignoreBalance: command.ignore_balance,
  });
  return {};
}

async function dispatchInvoiceDelete(
  command: Extract<FixtureCommand, { kind: 'invoice.delete' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<DeleteInvoiceUseCase>('deleteInvoiceUseCase');
  await useCase.execute(command.card_id, command.period);
  return {};
}

async function dispatchInvoiceSummaries(
  command: Extract<FixtureCommand, { kind: 'invoice.summaries' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<GetCardInvoicesUseCase>('getCardInvoicesUseCase');
  const invoices = await useCase.execute(command.card_id);
  return { projection: mapInvoiceTimeline(command.card_id, invoices) };
}

async function dispatchRecurrenceCreate(
  command: Extract<FixtureCommand, { kind: 'recurrence.create' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<CreateRecurrenceUseCase>('createRecurrenceUseCase');
  await useCase.execute(
    productIntent<Partial<Recurrence>>(command.record, 'recurrences'),
  );
  return {};
}

async function dispatchRecurrenceSetStatus(
  command: Extract<FixtureCommand, { kind: 'recurrence.set_status' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<ToggleRecurrenceStatusUseCase>(
    'toggleRecurrenceStatusUseCase',
  );
  await useCase.execute(command.id, command.status);
  return {};
}

async function dispatchRecurrenceLaunch(
  command: Extract<FixtureCommand, { kind: 'recurrence.launch' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<LaunchRecurrenceUseCase>('launchRecurrenceUseCase');
  await useCase.execute(command.id);
  return {};
}

async function dispatchRecurrenceProcessMonth(
  command: Extract<FixtureCommand, { kind: 'recurrence.process_month' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<ProcessMonthlyRecurrencesUseCase>(
    'processMonthlyRecurrencesUseCase',
  );
  await useCase.execute();
  return {};
}

interface ForecastTimelineRow {
  date: string;
  balance: number;
}

interface ForecastUpcomingRow {
  card_id: string;
  card_name: string;
  dateStr: string;
  amount: number;
  status: string;
}

interface ForecastResult {
  timeline: ForecastTimelineRow[];
  upcomingInvoices: ForecastUpcomingRow[];
}

async function dispatchForecastGenerate(
  command: Extract<FixtureCommand, { kind: 'forecast.generate' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<GenerateForecastUseCase>('generateForecastUseCase');
  const result: ForecastResult = await useCase.execute({
    startDate: command.start_date,
    endDate: command.end_date,
    includeSimulations: command.include_simulations ? 'true' : 'false',
  });
  return { projection: mapForecast(command, result) };
}

interface BudgetRow {
  id: string;
  monthly_budget: number;
  spent: number;
}

async function dispatchBudgetSummaries(
  command: Extract<FixtureCommand, { kind: 'budget.summaries' }>,
  scope: AwilixContainer,
  clock: SyncClock,
): Promise<DispatchResult> {
  const useCase = scope.resolve<GetBudgetsUseCase>('getBudgetsUseCase');
  const rows: BudgetRow[] = await useCase.execute();
  return { projection: mapBudgets(rows, clock.now()) };
}

async function dispatchProjectPayment(
  command: Extract<FixtureCommand, { kind: 'project.payment' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<RegisterPaymentUseCase>('registerPaymentUseCase');
  const body: { amount: number; description?: string } = {
    amount: moneyToProductNumber(command.amount),
  };
  if (command.description !== undefined) body.description = command.description;
  await useCase.execute(command.project_id, body);
  return {};
}

async function dispatchProjectComplete(
  command: Extract<FixtureCommand, { kind: 'project.complete' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<CompleteProjectUseCase>('completeProjectUseCase');
  await useCase.execute(command.id);
  return {};
}

interface ProjectRow {
  id: string;
  status: string;
  total_value: number;
  received: number;
  remaining: number;
}

async function dispatchProjectSummaries(
  command: Extract<FixtureCommand, { kind: 'project.summaries' }>,
  scope: AwilixContainer,
): Promise<DispatchResult> {
  const useCase = scope.resolve<ListProjectsUseCase>('listProjectsUseCase');
  const rows: ProjectRow[] = await useCase.execute();
  return { projection: mapProjects(rows) };
}

function mapForecast(
  command: Extract<FixtureCommand, { kind: 'forecast.generate' }>,
  result: ForecastResult,
): RawForecastProjection {
  const timeline = result.timeline.map((entry) => ({
    date: entry.date,
    balance: canonicalDecimal(entry.balance),
  }));
  const upcoming = result.upcomingInvoices.map((entry) => ({
    card_id: entry.card_id,
    card_name: entry.card_name,
    due_date: `${entry.dateStr}T00:00:00.000Z`,
    amount_due: canonicalDecimal(entry.amount),
    status: entry.status,
  }));
  const firstNegative = timeline.find((entry) => isNegativeMoney(entry.balance));

  return {
    kind: 'forecast',
    // The range and the simulation toggle are request context (the product
    // response does not echo them); the dated timeline and invoice amounts
    // are the product's own output and prove the window/simulation effect.
    start_date: command.start_date,
    end_date: command.end_date,
    include_simulations: command.include_simulations,
    timeline,
    upcoming_invoices: upcoming,
    // Presentation derivation from the product timeline, per the protocol.
    first_negative_date: firstNegative
      ? `${firstNegative.date}T00:00:00.000Z`
      : null,
  };
}

function mapBudgets(rows: BudgetRow[], asOf: string): RawBudgetsProjection {
  const categories = rows
    .map((row) => ({
      category_id: row.id,
      monthly_budget: canonicalDecimal(row.monthly_budget),
      spent: canonicalDecimal(row.spent),
    }))
    .sort((left, right) =>
      left.category_id < right.category_id
        ? -1
        : left.category_id > right.category_id
          ? 1
          : 0,
    );

  return {
    kind: 'budgets',
    // as_of echoes the injected operation clock; the product owns the month
    // window and every projected amount.
    as_of: normalizeInstant(asOf, 'actual', 'budgets.as_of'),
    categories,
  };
}

function mapProjects(rows: ProjectRow[]): RawProjectsProjection {
  const projects = rows
    .map((row) => ({
      project_id: row.id,
      status: row.status,
      total_value: canonicalDecimal(row.total_value),
      paid: canonicalDecimal(row.received),
      remaining: canonicalDecimal(row.remaining),
    }))
    .sort((left, right) =>
      left.project_id < right.project_id
        ? -1
        : left.project_id > right.project_id
          ? 1
          : 0,
    );

  return { kind: 'projects', projects };
}

function mapInvoiceTimeline(
  cardId: string,
  invoices: GetCardInvoicesResponse[],
): RawInvoiceTimelineProjection {
  return {
    kind: 'invoice_timeline',
    card_id: cardId,
    invoices: invoices.map((invoice) => ({
      period: invoice.period,
      due_date: normalizeInstant(invoice.dueDate, 'actual', 'invoice_timeline.due_date'),
      status: invoice.status,
      debt: canonicalDecimal(invoice.totalAmount),
      paid_amount: canonicalDecimal(invoice.paidAmount),
      total_spent: canonicalDecimal(invoice.totalSpent),
      lines: invoice.transactions.map((line) => {
        const mapped: RawInvoiceTimelineLine = {
          amount: canonicalDecimal(line.amount),
          status: line.status,
          expected_date: normalizeInstant(
            line.expected_date,
            'actual',
            'invoice_timeline.line.expected_date',
          ),
        };
        // Projected lines own a derived id and title in the product response;
        // neither belongs to the parity contract.
        if (line.status !== 'projected') mapped.id = line.id;
        if (line.purchase_date) {
          mapped.purchase_date = normalizeInstant(
            line.purchase_date,
            'actual',
            'invoice_timeline.line.purchase_date',
          );
        }
        if (line.recurrence_id) mapped.recurrence_id = line.recurrence_id;
        return mapped;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Error canonicalization
// ---------------------------------------------------------------------------

function findRecord(
  snapshot: CanonicalSnapshot,
  collection: CollectionName,
  id: string,
): CanonicalRecord | undefined {
  return snapshot[collection].find((record) => record.id === id);
}

const RELATION_TARGETS: ReadonlyArray<{
  field: string;
  collection: CollectionName;
  entity: string;
}> = [
  { field: 'account_id', collection: 'accounts', entity: 'Account' },
  { field: 'destination_account_id', collection: 'accounts', entity: 'Account' },
  { field: 'card_id', collection: 'cards', entity: 'Card' },
  { field: 'project_id', collection: 'projects', entity: 'Project' },
  { field: 'category_id', collection: 'categories', entity: 'Category' },
  { field: 'recurrence_id', collection: 'recurrences', entity: 'Recurrence' },
  { field: 'invoice_id', collection: 'invoices', entity: 'Invoice' },
];

function deriveMissingRelation(
  record: Record<string, unknown>,
  pre: CanonicalSnapshot,
): { entity?: string; entity_id?: string } {
  for (const target of RELATION_TARGETS) {
    const value = record[target.field];
    if (typeof value !== 'string' || value.length === 0) continue;
    const exists = pre[target.collection].some((row) => row.id === value);
    if (!exists) return { entity: target.entity, entity_id: value };
  }
  return {};
}

function deriveEntity(
  command: FixtureCommand,
  pre: CanonicalSnapshot,
): { entity?: string; entity_id?: string } {
  switch (command.kind) {
    case 'transaction.realize':
    case 'transaction.delete':
    case 'transaction.set_simulated':
      return { entity: 'Transaction', entity_id: command.id };
    case 'transaction.update': {
      const existing = findRecord(pre, 'transactions', command.id);
      if (!existing) return { entity: 'Transaction', entity_id: command.id };
      return deriveMissingRelation(command.patch, pre);
    }
    case 'transaction.create':
      return deriveMissingRelation(command.record, pre);
    case 'recurrence.create':
      return deriveMissingRelation(command.record, pre);
    case 'recurrence.launch':
    case 'recurrence.set_status':
      return { entity: 'Recurrence', entity_id: command.id };
    case 'project.payment':
      return { entity: 'Project', entity_id: command.project_id };
    case 'project.complete':
      return { entity: 'Project', entity_id: command.id };
    case 'invoice.pay':
    case 'invoice.delete':
    case 'invoice.summaries': {
      const cardExists = pre.cards.some((row) => row.id === command.card_id);
      return cardExists
        ? { entity: 'Invoice' }
        : { entity: 'Card', entity_id: command.card_id };
    }
    default:
      return {};
  }
}

function classifyValidation(
  command: FixtureCommand,
  pre: CanonicalSnapshot,
): CanonicalizedError['code'] {
  switch (command.kind) {
    case 'transaction.realize': {
      const transaction = findRecord(pre, 'transactions', command.id);
      if (transaction?.status === 'realized') return 'already_realized';
      if (transaction?.is_simulated === true) return 'invalid_state';
      return 'validation';
    }
    case 'recurrence.launch': {
      const recurrence = findRecord(pre, 'recurrences', command.id);
      if (recurrence?.status === 'ended') return 'invalid_state';
      return 'validation';
    }
    case 'invoice.pay': {
      const invoice = pre.invoices.find(
        (row) =>
          row.card_id === command.card_id && row.period === command.period,
      );
      if (!invoice) return 'validation';
      if (invoice.status === 'PAID') return 'already_paid';
      const total = String(invoice.total_amount);
      const paid = String(invoice.paid_amount);
      if (compareDecimal(subtractDecimal(total, paid), '0') <= 0) {
        return 'already_paid';
      }
      return 'validation';
    }
    default:
      return 'validation';
  }
}

export function canonicalizeCommandError(
  error: unknown,
  command: FixtureCommand,
  pre: CanonicalSnapshot,
): CanonicalizedError {
  const derived = deriveEntity(command, pre);

  if (error instanceof InjectedStorageFailure) {
    return { code: 'storage_failure' };
  }

  if (error instanceof DomainError) {
    switch (error.code) {
      case 'VALIDATION_ERROR':
        return { code: classifyValidation(command, pre), ...derived };
      case 'NOT_FOUND':
        return { code: 'not_found', ...derived };
      case 'CONFLICT':
        return { code: 'conflict', ...derived };
      case 'EXPIRED':
        return { code: 'invalid_state', ...derived };
      default:
        return { code: 'unclassified', ...derived, detail: error.name };
    }
  }

  if (error instanceof ClientResponseError) {
    switch (error.status) {
      case 404:
        return { code: 'not_found', ...derived };
      case 400:
        return { code: 'validation', ...derived };
      case 409:
        return { code: 'conflict', ...derived };
      default:
        if (error.status >= 500) {
          return { code: 'storage_failure', ...derived };
        }
        return {
          code: 'unclassified',
          ...derived,
          detail: `${error.name}:${error.status}`,
        };
    }
  }

  if (error instanceof CoordinatorOutcomeError) {
    if (error.outcome === 'conflict') {
      return { code: 'conflict', ...derived };
    }
    return {
      code: 'unclassified',
      ...derived,
      detail: `${error.outcome}${error.code.length > 0 ? `:${error.code}` : ''}`,
    };
  }

  return {
    code: 'unclassified',
    ...derived,
    detail: error instanceof Error ? error.name : typeof error,
  };
}
