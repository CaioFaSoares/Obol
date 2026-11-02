// Shared types for the finance parity acceptance runner.
//
// These types describe the fixture protocol in shared/finance-parity/README.md
// and the canonical comparison view. They contain no product behavior: every
// expected value is loaded from the fixture files and every actual value is
// read from PocketBase after a real use-case invocation.

import type { SyncEntityType } from '../../src/domain/sync/SyncRevision';

export const COLLECTION_NAMES = [
  'accounts',
  'cards',
  'categories',
  'invoices',
  'projects',
  'recurrences',
  'transactions',
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];

/** Singular sync entity type for each finance collection. */
export const SYNC_ENTITY_BY_COLLECTION: Readonly<Record<CollectionName, SyncEntityType>> = {
  accounts: 'account',
  cards: 'card',
  categories: 'category',
  invoices: 'invoice',
  projects: 'project',
  recurrences: 'recurrence',
  transactions: 'transaction',
};

/** Parent-before-child order for seeding into PocketBase. */
export const SEED_ORDER: readonly CollectionName[] = [
  'accounts',
  'cards',
  'categories',
  'projects',
  'invoices',
  'recurrences',
  'transactions',
];

/** Child-before-parent order for deleting a case's financial rows. */
export const CLEAR_FINANCE_ORDER: readonly CollectionName[] = [
  'transactions',
  'invoices',
  'recurrences',
  'projects',
  'cards',
  'accounts',
  'categories',
];

/** Sync metadata collections owned by the runner in the isolated database. */
export const SYNC_COLLECTIONS = [
  'obol_sync_changes',
  'obol_sync_operations',
  'obol_sync_entity_versions',
  'obol_sync_meta',
  'obol_station_outbox',
  'obol_station_conflicts',
  'obol_station_versions',
  'obol_station_state',
  'obol_sync_stations',
] as const;

export const ISOLATED_APP_NAME = 'Obol finance parity isolated';

/** Wildcard accepted only for an expected transaction title. */
export const GENERATED_TITLE = '*generated*';

export type Money = string;
export type RawRecord = Record<string, unknown>;
export type RawSnapshot = Record<CollectionName, RawRecord[]>;

export interface ClockSpec {
  now: string;
  effective_at?: string;
  applied_at?: string;
}

export interface CaptureSpec {
  collection: CollectionName;
  where: Record<string, unknown>;
}

export type CaptureMap = Record<string, CaptureSpec>;

export interface FaultSpec {
  on_write: {
    collection: CollectionName;
    record_id?: string;
    operation?: 'create' | 'update' | 'delete';
  };
  error: 'storage_failure';
}

interface CommandBase {
  fault?: FaultSpec;
}

export interface AccountCreateCommand extends CommandBase {
  kind: 'account.create';
  record: RawRecord;
  capture?: CaptureMap;
}

export interface TransactionCreateCommand extends CommandBase {
  kind: 'transaction.create';
  record: RawRecord;
  capture?: CaptureMap;
}

export interface TransactionUpdateCommand extends CommandBase {
  kind: 'transaction.update';
  id: string;
  patch: RawRecord;
}

export interface TransactionRealizeCommand extends CommandBase {
  kind: 'transaction.realize';
  id: string;
  update_balance: boolean;
}

export interface TransactionDeleteCommand extends CommandBase {
  kind: 'transaction.delete';
  id: string;
}

export interface TransactionSetSimulatedCommand extends CommandBase {
  kind: 'transaction.set_simulated';
  id: string;
  is_simulated: boolean;
}

export interface InvoicePayCommand extends CommandBase {
  kind: 'invoice.pay';
  card_id: string;
  period: string;
  account_id?: string;
  amount_paid?: Money;
  ignore_balance: boolean;
  capture?: CaptureMap;
}

export interface InvoiceDeleteCommand extends CommandBase {
  kind: 'invoice.delete';
  card_id: string;
  period: string;
}

export interface InvoiceSummariesCommand extends CommandBase {
  kind: 'invoice.summaries';
  card_id: string;
}

export interface RecurrenceCreateCommand extends CommandBase {
  kind: 'recurrence.create';
  record: RawRecord;
  capture?: CaptureMap;
}

export interface RecurrenceSetStatusCommand extends CommandBase {
  kind: 'recurrence.set_status';
  id: string;
  status: 'active' | 'paused';
}

export interface RecurrenceLaunchCommand extends CommandBase {
  kind: 'recurrence.launch';
  id: string;
  capture?: CaptureMap;
}

export interface RecurrenceProcessMonthCommand extends CommandBase {
  kind: 'recurrence.process_month';
  capture?: CaptureMap;
}

export interface ForecastGenerateCommand extends CommandBase {
  kind: 'forecast.generate';
  start_date: string;
  end_date: string;
  include_simulations: boolean;
}

export interface BudgetSummariesCommand extends CommandBase {
  kind: 'budget.summaries';
}

export interface ProjectPaymentCommand extends CommandBase {
  kind: 'project.payment';
  project_id: string;
  amount: Money;
  description?: string;
  capture?: CaptureMap;
}

export interface ProjectCompleteCommand extends CommandBase {
  kind: 'project.complete';
  id: string;
}

export interface ProjectSummariesCommand extends CommandBase {
  kind: 'project.summaries';
}

export type FixtureCommand =
  | AccountCreateCommand
  | TransactionCreateCommand
  | TransactionUpdateCommand
  | TransactionRealizeCommand
  | TransactionDeleteCommand
  | TransactionSetSimulatedCommand
  | InvoicePayCommand
  | InvoiceDeleteCommand
  | InvoiceSummariesCommand
  | RecurrenceCreateCommand
  | RecurrenceSetStatusCommand
  | RecurrenceLaunchCommand
  | RecurrenceProcessMonthCommand
  | ForecastGenerateCommand
  | BudgetSummariesCommand
  | ProjectPaymentCommand
  | ProjectCompleteCommand
  | ProjectSummariesCommand;


export type CanonicalErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'referenced'
  | 'already_realized'
  | 'already_paid'
  | 'invalid_state'
  | 'invalid_identifier'
  | 'storage_failure';

export interface ExpectedError {
  code: CanonicalErrorCode;
  entity?: string;
  entity_id?: string;
}

export interface RawForecastTimelineEntry {
  date: string;
  balance: Money;
}

export interface RawForecastInvoiceEntry {
  card_id: string;
  card_name: string;
  due_date: string;
  amount_due: Money;
  status: string;
}

export interface RawForecastProjection {
  kind: 'forecast';
  start_date: string;
  end_date: string;
  include_simulations: boolean;
  timeline: RawForecastTimelineEntry[];
  upcoming_invoices: RawForecastInvoiceEntry[];
  first_negative_date: string | null;
}

export interface RawBudgetCategory {
  category_id: string;
  monthly_budget: Money;
  spent: Money;
}

export interface RawBudgetsProjection {
  kind: 'budgets';
  as_of: string;
  categories: RawBudgetCategory[];
}

export interface RawProjectSummary {
  project_id: string;
  status: string;
  total_value: Money;
  paid: Money;
  remaining: Money;
}

export interface RawProjectsProjection {
  kind: 'projects';
  projects: RawProjectSummary[];
}

export interface RawInvoiceTimelineLine {
  id?: string;
  amount: Money;
  status: string;
  expected_date: string;
  purchase_date?: string | null;
  recurrence_id?: string | null;
}

export interface RawInvoiceTimelineInvoice {
  period: string;
  due_date: string;
  status: string;
  debt: Money;
  paid_amount: Money;
  total_spent: Money;
  lines: RawInvoiceTimelineLine[];
}

export interface RawInvoiceTimelineProjection {
  kind: 'invoice_timeline';
  card_id: string;
  invoices: RawInvoiceTimelineInvoice[];
}

export type RawProjection =
  | RawForecastProjection
  | RawBudgetsProjection
  | RawProjectsProjection
  | RawInvoiceTimelineProjection;

export interface CaseExpectation {
  error?: ExpectedError;
  snapshot?: RawSnapshot;
  projections?: RawProjection[];
}

export interface DivergenceNote {
  against: string;
  policy: string;
  source: string;
  note: string;
}

export interface FixtureCase {
  id: string;
  purpose: string;
  clock: ClockSpec;
  requires?: string[];
  divergence?: DivergenceNote;
  known_blocker?: string;
  initial: RawSnapshot;
  commands: FixtureCommand[];
  expect: CaseExpectation;
}

export interface FixtureFile {
  protocol: 1;
  file: string;
  title: string;
  cases: FixtureCase[];
}

// ---------------------------------------------------------------------------
// Canonical comparison view
// ---------------------------------------------------------------------------

export type CanonicalValue = string | number | boolean | null | string[];

export interface CanonicalRecord {
  id: string;
  [field: string]: CanonicalValue;
}

export type CanonicalSnapshot = Record<CollectionName, CanonicalRecord[]>;

export interface CanonicalForecastProjection {
  kind: 'forecast';
  start_date: string;
  end_date: string;
  include_simulations: boolean;
  timeline: RawForecastTimelineEntry[];
  upcoming_invoices: RawForecastInvoiceEntry[];
  first_negative_date: string | null;
}

export interface CanonicalBudgetsProjection {
  kind: 'budgets';
  as_of: string;
  categories: RawBudgetCategory[];
}

export interface CanonicalProjectsProjection {
  kind: 'projects';
  projects: RawProjectSummary[];
}

export interface CanonicalInvoiceTimelineProjection {
  kind: 'invoice_timeline';
  card_id: string;
  invoices: RawInvoiceTimelineInvoice[];
}

export type CanonicalProjection =
  | CanonicalForecastProjection
  | CanonicalBudgetsProjection
  | CanonicalProjectsProjection
  | CanonicalInvoiceTimelineProjection;

export interface CanonicalizedError {
  code: CanonicalErrorCode | 'unclassified';
  entity?: string;
  entity_id?: string;
  /** Typed error name or coordinator outcome only; never a message body. */
  detail?: string;
}

export interface RuntimeConfig {
  url: string;
  adminEmail: string;
  adminPassword: string;
  ioTimeoutMs: number;
  commandTimeoutMs: number;
  fixturesDir?: string;
}

export interface CaseResult {
  file: string;
  id: string;
  status: 'pass' | 'fail';
  lines: string[];
  /** Present when the runner cannot safely continue (timeout, cleanup, I/O). */
  fatal?: string;
}
