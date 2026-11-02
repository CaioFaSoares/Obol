// Fixture loading and protocol validation.
//
// The runner never ignores an unknown field, a JSON number used as money, a
// malformed id, an unsupported command kind, or a missing canonical case. A
// fixture that violates the protocol fails the suite before any database write.

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COLLECTION_SPECS,
  CREATE_DEFAULTED_FIELDS,
  REQUIRED_RECORD_FIELDS,
  isPlainObject,
  normalizeDay,
  normalizeInstant,
  normalizePeriod,
  normalizePeriodOrDay,
  type FieldSpec,
} from './canonical';
import { isMoneyString } from './decimal';
import {
  COLLECTION_NAMES,
  GENERATED_TITLE,
  type CollectionName,
  type FixtureCase,
  type FixtureFile,
  type RawRecord,
} from './types';

export const FIXTURE_FILE_NAMES = [
  'transactions',
  'invoices',
  'recurrences',
  'forecast',
  'budgets',
  'projects',
] as const;

export type FixtureFileName = (typeof FIXTURE_FILE_NAMES)[number];

/** Canonical case inventory (PAR-01). Missing or extra cases fail the suite. */
export const EXPECTED_CASE_IDS: Readonly<Record<FixtureFileName, readonly string[]>> = {
  transactions: [
    'txn-realize-ordinary',
    'txn-realize-silent',
    'txn-realize-already-realized',
    'txn-realize-simulated',
    'txn-create-realized-simulation',
    'txn-convert-simulation',
    'txn-money-half-cent',
    'txn-create-half-cent-cash',
    'txn-edit-realized',
    'txn-delete-realized',
    'txn-transfer-neutral',
    'txn-transfer-atomic-failure',
    'txn-effective-at-offline',
    'txn-midnight-boundary',
    'txn-invalid-same-account',
    'txn-invalid-missing-account',
  ],
  invoices: [
    'inv-card-purchase-boundary',
    'inv-year-rollover',
    'inv-partial-payment',
    'inv-full-payment',
    'inv-silent-payoff',
    'inv-payment-exceeds-debt',
    'inv-child-delete',
    'inv-delete-invoice',
    'inv-projection-no-double-count',
    'inv-payment-atomic-failure',
    'inv-weekly-card-projection',
  ],
  recurrences: [
    'rec-payday-clamp-february',
    'rec-month-idempotency',
    'rec-pause-resume',
    'rec-end-date-expiry',
    'rec-finite-installments',
    'rec-launch-next-month',
    'rec-launch-card-invoice',
    'rec-skipped-period',
    'rec-deleted-child-skips',
    'rec-ended-launch-error',
    'rec-invalid-account-and-card',
    'rec-weekly-current-week',
    'rec-weekly-same-week-idempotent',
    'rec-weekly-skip-key',
    'rec-weekly-launch-next-week',
    'rec-weekly-installments',
    'rec-weekly-week-crosses-month',
  ],
  forecast: [
    'fcst-rollback-and-pending',
    'fcst-overdue-pending',
    'fcst-investment-exclusion',
    'fcst-unassigned-pending',
    'fcst-overdue-invoice-past',
    'fcst-transfer-to-investment',
    'fcst-weekly-occurrences',
  ],
  budgets: ['budget-accrual'],
  projects: ['project-payment-lifecycle', 'project-payment-missing'],
};

const COMMAND_KEYS: Readonly<Record<string, readonly string[]>> = {
  'account.create': ['kind', 'record', 'capture', 'fault'],
  'transaction.create': ['kind', 'record', 'capture', 'fault'],
  'transaction.update': ['kind', 'id', 'patch', 'fault'],
  'transaction.realize': ['kind', 'id', 'update_balance', 'fault'],
  'transaction.delete': ['kind', 'id', 'fault'],
  'transaction.set_simulated': ['kind', 'id', 'is_simulated', 'fault'],
  'invoice.pay': [
    'kind',
    'card_id',
    'period',
    'account_id',
    'amount_paid',
    'ignore_balance',
    'capture',
    'fault',
  ],
  'invoice.delete': ['kind', 'card_id', 'period', 'fault'],
  'invoice.summaries': ['kind', 'card_id'],
  'recurrence.create': ['kind', 'record', 'capture', 'fault'],
  'recurrence.set_status': ['kind', 'id', 'status', 'fault'],
  'recurrence.launch': ['kind', 'id', 'capture', 'fault'],
  'recurrence.process_month': ['kind', 'capture', 'fault'],
  'forecast.generate': [
    'kind',
    'start_date',
    'end_date',
    'include_simulations',
  ],
  'budget.summaries': ['kind'],
  'project.payment': [
    'kind',
    'project_id',
    'amount',
    'description',
    'capture',
    'fault',
  ],
  'project.complete': ['kind', 'id', 'fault'],
  'project.summaries': ['kind'],
};

const PROJECTION_COMMANDS: Readonly<Record<string, true>> = {
  'invoice.summaries': true,
  'forecast.generate': true,
  'budget.summaries': true,
  'project.summaries': true,
};

const CAPABILITY_FLAGS: Readonly<Record<string, true>> = {
  exact_decimal_money: true,
  relation_validation: true,
  atomic_compound_writes: true,
  effective_at_clock: true,
  invoice_projection: true,
};

const CANONICAL_ERROR_CODES: Readonly<Record<string, true>> = {
  validation: true,
  not_found: true,
  conflict: true,
  referenced: true,
  already_realized: true,
  already_paid: true,
  invalid_state: true,
  invalid_identifier: true,
  storage_failure: true,
};

const CASE_KEYS = [
  'id',
  'purpose',
  'clock',
  'requires',
  'divergence',
  'known_blocker',
  'initial',
  'commands',
  'expect',
] as const;

const CLOCK_KEYS = ['now', 'effective_at', 'applied_at'] as const;
const DIVERGENCE_KEYS = ['against', 'policy', 'source', 'note'] as const;
const EXPECT_KEYS = ['error', 'snapshot', 'projections'] as const;
const ERROR_KEYS = ['code', 'entity', 'entity_id'] as const;
const CAPTURE_KEYS = ['collection', 'where'] as const;
const FAULT_KEYS = ['on_write', 'error'] as const;
const ON_WRITE_KEYS = ['collection', 'record_id', 'operation'] as const;

const TOKEN_PATTERN = /^\$([a-z][a-z0-9]*)$/;
const CAPTURE_NAME_PATTERN = /^[a-z][a-z0-9]*$/;
const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENTITY_ID_PATTERN = /^[a-z0-9]{15}$/;

export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureValidationError';
  }
}

function fail(path: string, message: string): never {
  throw new FixtureValidationError(`${path}: ${message}`);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `unknown field "${key}"`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  assertKnownKeys(value, expected, path);
  for (const key of expected) {
    if (!(key in value)) fail(path, `missing field "${key}"`);
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, 'expected an object');
  return value;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function requireInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(path, 'expected an integer');
  }
  return value;
}

function isCollectionName(value: string): value is CollectionName {
  return COLLECTION_NAMES.some((name) => name === value);
}

function assertIdOrToken(value: unknown, path: string, allowToken: boolean): void {
  const text = requireString(value, path);
  if (TOKEN_PATTERN.test(text)) {
    if (!allowToken) fail(path, 'capture tokens are not allowed here');
    return;
  }
  if (!ENTITY_ID_PATTERN.test(text)) {
    fail(path, `expected a 15-character lowercase id, got "${text}"`);
  }
}

interface FieldContext {
  allowToken: boolean;
  allowGeneratedTitle: boolean;
  optional: boolean;
}

function validateFieldValue(
  field: string,
  spec: FieldSpec,
  value: unknown,
  path: string,
  context: FieldContext,
): void {
  if (value === GENERATED_TITLE && !(field === 'title' && context.allowGeneratedTitle)) {
    fail(path, 'the *generated* title wildcard is valid only for an expected title');
  }

  switch (spec.kind) {
    case 'money':
      if (!isMoneyString(value)) fail(path, 'expected a decimal money string');
      return;
    case 'paid-money':
    case 'nullable-money':
      if (value === null) {
        if (!context.optional) fail(path, 'null is not allowed for a required money field');
        return;
      }
      if (!isMoneyString(value)) fail(path, 'expected a decimal money string or null');
      return;
    case 'instant':
      if (value === null) {
        if (!context.optional) fail(path, 'null is not allowed for a required instant');
        return;
      }
      normalizeInstant(value, 'expected', path);
      return;
    case 'relation':
      if (value === null || value === '') {
        if (!context.optional) fail(path, 'a required relation cannot be null');
        return;
      }
      assertIdOrToken(value, path, context.allowToken);
      return;
    case 'bool':
      if (value === null) {
        if (!context.optional) fail(path, 'null is not allowed for a required boolean');
        return;
      }
      requireBoolean(value, path);
      return;
    case 'int': {
      const number = requireInteger(value, path);
      if (field === 'closing_day' || field === 'due_day' || field === 'payday') {
        if (number < 1 || number > 31) fail(path, 'day must be between 1 and 31');
      }
      return;
    }
    case 'nullable-int': {
      if (value === null) {
        if (!context.optional) fail(path, 'null is not allowed here');
        return;
      }
      const number = requireInteger(value, path);
      if (number < 0) fail(path, 'value cannot be negative');
      return;
    }
    case 'period-list': {
      if (value === null) {
        if (!context.optional) fail(path, 'null is not allowed here');
        return;
      }
      const list = asArray(value, path);
      list.forEach((entry, index) => normalizePeriodOrDay(entry, `${path}[${index}]`));
      return;
    }
    case 'cadence': {
      if (value === null) {
        if (!context.optional) fail(path, 'null is not allowed here');
        return;
      }
      const text = requireString(value, path);
      if (text !== 'monthly' && text !== 'weekly') {
        fail(path, `cadence "${text}" is not monthly or weekly`);
      }
      return;
    }
    case 'text':
      if (field === 'period') {
        normalizePeriod(value, path);
        return;
      }
      requireString(value, path);
      return;
    case 'enum': {
      const text = requireString(value, path);
      if (spec.values && !spec.values.includes(text)) {
        fail(path, `value "${text}" is not one of ${spec.values.join(', ')}`);
      }
      return;
    }
    default:
      fail(path, 'unsupported field kind');
  }
}

type RecordOrigin = 'initial' | 'expected' | 'create' | 'patch';

interface RecordValidationOptions {
  origin: RecordOrigin;
  allowToken: boolean;
  allowGeneratedTitle: boolean;
}

function validateRecord(
  value: unknown,
  collection: CollectionName,
  path: string,
  options: RecordValidationOptions,
): void {
  const object = asObject(value, path);
  const spec = COLLECTION_SPECS[collection];
  const allowed = ['id', ...Object.keys(spec.fields)];
  assertKnownKeys(object, allowed, path);

  const required =
    options.origin === 'create'
      ? REQUIRED_RECORD_FIELDS[collection].filter(
          (field) =>
            field !== 'id' && !CREATE_DEFAULTED_FIELDS[collection].includes(field),
        )
      : options.origin === 'patch'
        ? []
        : REQUIRED_RECORD_FIELDS[collection];

  for (const field of required) {
    if (!(field in object)) fail(path, `missing required field "${field}"`);
  }

  if (
    (options.origin === 'create' || options.origin === 'patch') &&
    Object.prototype.hasOwnProperty.call(object, 'id')
  ) {
    fail(path, `${options.origin} records must not carry an id`);
  }

  for (const [field, fieldValue] of Object.entries(object)) {
    if (field === 'id') {
      assertIdOrToken(fieldValue, `${path}.id`, options.allowToken);
      continue;
    }
    const fieldSpec = spec.fields[field];
    if (!fieldSpec) fail(path, `unknown field "${field}"`);
    validateFieldValue(field, fieldSpec, fieldValue, `${path}.${field}`, {
      allowToken: options.allowToken,
      allowGeneratedTitle: options.allowGeneratedTitle,
      optional: !REQUIRED_RECORD_FIELDS[collection].includes(field),
    });
  }
}

function validateSnapshot(
  value: unknown,
  path: string,
  origin: 'initial' | 'expected',
): void {
  const object = asObject(value, path);
  assertExactKeys(object, COLLECTION_NAMES, path);

  for (const collection of COLLECTION_NAMES) {
    const rows = asArray(object[collection], `${path}.${collection}`);
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const rowPath = `${path}.${collection}[${index}]`;
      validateRecord(row, collection, rowPath, {
        origin,
        allowToken: origin === 'expected',
        allowGeneratedTitle: origin === 'expected',
      });
      const record = row as RawRecord;
      if (typeof record.id === 'string' && !TOKEN_PATTERN.test(record.id)) {
        if (seen.has(record.id)) {
          fail(rowPath, `duplicate record id "${record.id}"`);
        }
        seen.add(record.id);
      }
    });
  }
}

function validateClock(value: unknown, path: string): void {
  const object = asObject(value, path);
  // Protocol: only `now` is required. `effective_at` is the optional offline
  // business time and `applied_at` is optional replay audit data.
  assertKnownKeys(object, CLOCK_KEYS, path);
  if (!('now' in object)) fail(path, 'missing required field "now"');
  normalizeInstant(object.now, 'expected', `${path}.now`);
  if (object.effective_at !== undefined) {
    normalizeInstant(object.effective_at, 'expected', `${path}.effective_at`);
  }
  if (object.applied_at !== undefined) {
    normalizeInstant(object.applied_at, 'expected', `${path}.applied_at`);
  }
}

function validateCaptureMap(value: unknown, path: string): string[] {
  const object = asObject(value, path);
  const names: string[] = [];
  for (const [name, rawSpec] of Object.entries(object)) {
    if (!CAPTURE_NAME_PATTERN.test(name)) {
      fail(`${path}.${name}`, 'capture names must be lowercase letters and digits');
    }
    const specPath = `${path}.${name}`;
    const spec = asObject(rawSpec, specPath);
    assertExactKeys(spec, CAPTURE_KEYS, specPath);
    const collection = requireString(spec.collection, `${specPath}.collection`);
    if (!isCollectionName(collection)) {
      fail(`${specPath}.collection`, `unknown collection "${collection}"`);
    }
    const collectionName = collection;
    const where = asObject(spec.where, `${specPath}.where`);
    const fields = COLLECTION_SPECS[collectionName].fields;
    for (const [field, fieldValue] of Object.entries(where)) {
      if (field === 'id') {
        assertIdOrToken(fieldValue, `${specPath}.where.id`, true);
        continue;
      }
      const fieldSpec = fields[field];
      if (!fieldSpec) fail(`${specPath}.where`, `unknown field "${field}"`);
      validateFieldValue(field, fieldSpec, fieldValue, `${specPath}.where.${field}`, {
        allowToken: true,
        allowGeneratedTitle: false,
        optional: !REQUIRED_RECORD_FIELDS[collectionName].includes(field),
      });
    }
    names.push(name);
  }
  return names;
}

function validateFault(value: unknown, path: string): void {
  const object = asObject(value, path);
  assertExactKeys(object, FAULT_KEYS, path);
  if (object.error !== 'storage_failure') {
    fail(`${path}.error`, 'only "storage_failure" is supported');
  }
  const onWrite = asObject(object.on_write, `${path}.on_write`);
  // Protocol: only `collection` is required. `record_id` and `operation` are
  // optional refinements of the failing write target.
  assertKnownKeys(onWrite, ON_WRITE_KEYS, `${path}.on_write`);
  const collection = requireString(onWrite.collection, `${path}.on_write.collection`);
  if (!isCollectionName(collection)) {
    fail(`${path}.on_write.collection`, `unknown collection "${collection}"`);
  }
  if (onWrite.record_id !== undefined) {
    assertIdOrToken(onWrite.record_id, `${path}.on_write.record_id`, true);
  }
  if (onWrite.operation !== undefined) {
    const operation = requireString(onWrite.operation, `${path}.on_write.operation`);
    if (
      operation !== 'create' &&
      operation !== 'update' &&
      operation !== 'delete'
    ) {
      fail(`${path}.on_write.operation`, 'expected create, update or delete');
    }
  }
}

interface ValidatedCommand {
  kind: string;
  captureNames: string[];
}

function validateCommand(value: unknown, path: string): ValidatedCommand {
  const object = asObject(value, path);
  const kind = requireString(object.kind, `${path}.kind`);
  const allowed = COMMAND_KEYS[kind];
  if (!allowed) fail(`${path}.kind`, `unsupported command kind "${kind}"`);
  assertKnownKeys(object, allowed, path);

  const captureNames: string[] = [];
  if (object.capture !== undefined) {
    captureNames.push(...validateCaptureMap(object.capture, `${path}.capture`));
  }
  if (object.fault !== undefined) {
    validateFault(object.fault, `${path}.fault`);
  }

  switch (kind) {
    case 'account.create':
    case 'recurrence.create':
    case 'transaction.create': {
      if (!('record' in object)) fail(path, 'missing required field "record"');
      const collection: CollectionName =
        kind === 'account.create'
          ? 'accounts'
          : kind === 'recurrence.create'
            ? 'recurrences'
            : 'transactions';
      validateRecord(object.record, collection, `${path}.record`, {
        origin: 'create',
        allowToken: true,
        allowGeneratedTitle: false,
      });
      break;
    }
    case 'transaction.update': {
      if (!('patch' in object)) fail(path, 'missing required field "patch"');
      assertIdOrToken(object.id, `${path}.id`, true);
      validateRecord(object.patch, 'transactions', `${path}.patch`, {
        origin: 'patch',
        allowToken: true,
        allowGeneratedTitle: false,
      });
      break;
    }
    case 'transaction.realize': {
      assertIdOrToken(object.id, `${path}.id`, true);
      requireBoolean(object.update_balance, `${path}.update_balance`);
      break;
    }
    case 'transaction.delete':
    case 'project.complete': {
      assertIdOrToken(object.id, `${path}.id`, true);
      break;
    }
    case 'transaction.set_simulated': {
      assertIdOrToken(object.id, `${path}.id`, true);
      requireBoolean(object.is_simulated, `${path}.is_simulated`);
      break;
    }
    case 'invoice.pay': {
      assertIdOrToken(object.card_id, `${path}.card_id`, true);
      normalizePeriod(object.period, `${path}.period`);
      if (object.account_id !== undefined) {
        assertIdOrToken(object.account_id, `${path}.account_id`, true);
      }
      if (object.amount_paid !== undefined) {
        if (!isMoneyString(object.amount_paid)) {
          fail(`${path}.amount_paid`, 'expected a decimal money string');
        }
      }
      requireBoolean(object.ignore_balance, `${path}.ignore_balance`);
      break;
    }
    case 'invoice.delete': {
      assertIdOrToken(object.card_id, `${path}.card_id`, true);
      normalizePeriod(object.period, `${path}.period`);
      break;
    }
    case 'invoice.summaries': {
      assertIdOrToken(object.card_id, `${path}.card_id`, true);
      break;
    }
    case 'recurrence.set_status': {
      assertIdOrToken(object.id, `${path}.id`, true);
      const status = requireString(object.status, `${path}.status`);
      if (status !== 'active' && status !== 'paused') {
        fail(`${path}.status`, 'expected active or paused');
      }
      break;
    }
    case 'recurrence.launch': {
      assertIdOrToken(object.id, `${path}.id`, true);
      break;
    }
    case 'recurrence.process_month':
    case 'budget.summaries':
    case 'project.summaries':
      break;
    case 'forecast.generate': {
      normalizeDay(object.start_date, `${path}.start_date`);
      normalizeDay(object.end_date, `${path}.end_date`);
      requireBoolean(object.include_simulations, `${path}.include_simulations`);
      break;
    }
    case 'project.payment': {
      assertIdOrToken(object.project_id, `${path}.project_id`, true);
      if (!isMoneyString(object.amount)) {
        fail(`${path}.amount`, 'expected a decimal money string');
      }
      if (object.description !== undefined) {
        requireString(object.description, `${path}.description`);
      }
      break;
    }
    default:
      fail(`${path}.kind`, `unsupported command kind "${kind}"`);
  }

  return { kind, captureNames };
}

function validateProjection(value: unknown, path: string): void {
  const object = asObject(value, path);
  const kind = requireString(object.kind, `${path}.kind`);

  switch (kind) {
    case 'forecast': {
      assertExactKeys(
        object,
        [
          'kind',
          'start_date',
          'end_date',
          'include_simulations',
          'timeline',
          'upcoming_invoices',
          'first_negative_date',
        ],
        path,
      );
      normalizeDay(object.start_date, `${path}.start_date`);
      normalizeDay(object.end_date, `${path}.end_date`);
      requireBoolean(object.include_simulations, `${path}.include_simulations`);
      asArray(object.timeline, `${path}.timeline`).forEach((entry, index) => {
        const entryPath = `${path}.timeline[${index}]`;
        const timeline = asObject(entry, entryPath);
        assertExactKeys(timeline, ['date', 'balance'], entryPath);
        normalizeDay(timeline.date, `${entryPath}.date`);
        if (!isMoneyString(timeline.balance)) {
          fail(`${entryPath}.balance`, 'expected a decimal money string');
        }
      });
      asArray(object.upcoming_invoices, `${path}.upcoming_invoices`).forEach(
        (entry, index) => {
          const entryPath = `${path}.upcoming_invoices[${index}]`;
          const invoice = asObject(entry, entryPath);
          assertExactKeys(
            invoice,
            ['card_id', 'card_name', 'due_date', 'amount_due', 'status'],
            entryPath,
          );
          assertIdOrToken(invoice.card_id, `${entryPath}.card_id`, true);
          requireString(invoice.card_name, `${entryPath}.card_name`);
          normalizeInstant(invoice.due_date, 'expected', `${entryPath}.due_date`);
          if (!isMoneyString(invoice.amount_due)) {
            fail(`${entryPath}.amount_due`, 'expected a decimal money string');
          }
          const status = requireString(invoice.status, `${entryPath}.status`);
          if (status !== 'OPEN' && status !== 'CLOSED') {
            fail(`${entryPath}.status`, 'expected OPEN or CLOSED');
          }
        },
      );
      if (object.first_negative_date !== null) {
        normalizeInstant(
          object.first_negative_date,
          'expected',
          `${path}.first_negative_date`,
        );
      }
      return;
    }
    case 'budgets': {
      assertExactKeys(object, ['kind', 'as_of', 'categories'], path);
      normalizeInstant(object.as_of, 'expected', `${path}.as_of`);
      asArray(object.categories, `${path}.categories`).forEach((entry, index) => {
        const entryPath = `${path}.categories[${index}]`;
        const category = asObject(entry, entryPath);
        assertExactKeys(
          category,
          ['category_id', 'monthly_budget', 'spent'],
          entryPath,
        );
        assertIdOrToken(category.category_id, `${entryPath}.category_id`, true);
        if (!isMoneyString(category.monthly_budget)) {
          fail(`${entryPath}.monthly_budget`, 'expected a decimal money string');
        }
        if (!isMoneyString(category.spent)) {
          fail(`${entryPath}.spent`, 'expected a decimal money string');
        }
      });
      return;
    }
    case 'projects': {
      assertExactKeys(object, ['kind', 'projects'], path);
      asArray(object.projects, `${path}.projects`).forEach((entry, index) => {
        const entryPath = `${path}.projects[${index}]`;
        const project = asObject(entry, entryPath);
        assertExactKeys(
          project,
          ['project_id', 'status', 'total_value', 'paid', 'remaining'],
          entryPath,
        );
        assertIdOrToken(project.project_id, `${entryPath}.project_id`, true);
        const status = requireString(project.status, `${entryPath}.status`);
        if (status !== 'active' && status !== 'completed') {
          fail(`${entryPath}.status`, 'expected active or completed');
        }
        for (const field of ['total_value', 'paid', 'remaining']) {
          if (!isMoneyString(project[field])) {
            fail(`${entryPath}.${field}`, 'expected a decimal money string');
          }
        }
      });
      return;
    }
    case 'invoice_timeline': {
      assertExactKeys(object, ['kind', 'card_id', 'invoices'], path);
      assertIdOrToken(object.card_id, `${path}.card_id`, true);
      asArray(object.invoices, `${path}.invoices`).forEach(
        (entry, invoiceIndex) => {
          const invoicePath = `${path}.invoices[${invoiceIndex}]`;
          const invoice = asObject(entry, invoicePath);
          assertExactKeys(
            invoice,
            [
              'period',
              'due_date',
              'status',
              'debt',
              'paid_amount',
              'total_spent',
              'lines',
            ],
            invoicePath,
          );
          normalizePeriod(invoice.period, `${invoicePath}.period`);
          normalizeInstant(invoice.due_date, 'expected', `${invoicePath}.due_date`);
          const invoiceStatus = requireString(
            invoice.status,
            `${invoicePath}.status`,
          );
          if (
            invoiceStatus !== 'OPEN' &&
            invoiceStatus !== 'CLOSED' &&
            invoiceStatus !== 'PAID' &&
            invoiceStatus !== 'PROJECTED'
          ) {
            fail(
              `${invoicePath}.status`,
              'expected OPEN, CLOSED, PAID or PROJECTED',
            );
          }
          for (const field of ['debt', 'paid_amount', 'total_spent']) {
            if (!isMoneyString(invoice[field])) {
              fail(`${invoicePath}.${field}`, 'expected a decimal money string');
            }
          }
          asArray(invoice.lines, `${invoicePath}.lines`).forEach(
            (lineEntry, lineIndex) => {
              const linePath = `${invoicePath}.lines[${lineIndex}]`;
              const line = asObject(lineEntry, linePath);
              assertKnownKeys(
                line,
                [
                  'id',
                  'amount',
                  'status',
                  'expected_date',
                  'purchase_date',
                  'recurrence_id',
                ],
                linePath,
              );
              for (const required of ['amount', 'status', 'expected_date']) {
                if (!(required in line)) {
                  fail(linePath, `missing required field "${required}"`);
                }
              }
              if (!isMoneyString(line.amount)) {
                fail(`${linePath}.amount`, 'expected a decimal money string');
              }
              const lineStatus = requireString(line.status, `${linePath}.status`);
              if (
                lineStatus !== 'pending' &&
                lineStatus !== 'realized' &&
                lineStatus !== 'projected'
              ) {
                fail(
                  `${linePath}.status`,
                  'expected pending, realized or projected',
                );
              }
              normalizeInstant(
                line.expected_date,
                'expected',
                `${linePath}.expected_date`,
              );
              if (line.id !== undefined) {
                if (lineStatus === 'projected') {
                  fail(`${linePath}.id`, 'a projected line must omit its id');
                }
                assertIdOrToken(line.id, `${linePath}.id`, true);
              }
              if (
                line.purchase_date !== undefined &&
                line.purchase_date !== null
              ) {
                normalizeInstant(
                  line.purchase_date,
                  'expected',
                  `${linePath}.purchase_date`,
                );
              }
              if (line.recurrence_id !== undefined && line.recurrence_id !== null) {
                assertIdOrToken(line.recurrence_id, `${linePath}.recurrence_id`, true);
              }
            },
          );
        },
      );
      return;
    }
    default:
      fail(`${path}.kind`, `unsupported projection kind "${kind}"`);
  }
}

function validateErrorExpectation(value: unknown, path: string): void {
  const object = asObject(value, path);
  // Protocol: `code` is required; `entity` and `entity_id` are optional — when
  // present in the fixture they are compared, when absent they are ignored.
  assertKnownKeys(object, ERROR_KEYS, path);
  const code = requireString(object.code, `${path}.code`);
  if (CANONICAL_ERROR_CODES[code] !== true) {
    fail(`${path}.code`, `unknown canonical error code "${code}"`);
  }
  if (object.entity !== undefined) {
    requireString(object.entity, `${path}.entity`);
  }
  if (object.entity_id !== undefined) {
    assertIdOrToken(object.entity_id, `${path}.entity_id`, true);
  }
}

function validateExpectation(
  value: unknown,
  path: string,
  commandKinds: readonly string[],
): void {
  const object = asObject(value, path);
  assertKnownKeys(object, EXPECT_KEYS, path);

  if (object.error !== undefined) {
    validateErrorExpectation(object.error, `${path}.error`);
    if (commandKinds.length === 0) {
      fail(`${path}.error`, 'an error expectation requires at least one command');
    }
  }
  if (object.snapshot !== undefined) {
    validateSnapshot(object.snapshot, `${path}.snapshot`, 'expected');
  }
  const projections =
    object.projections === undefined
      ? undefined
      : asArray(object.projections, `${path}.projections`);
  projections?.forEach((projection, index) =>
    validateProjection(projection, `${path}.projections[${index}]`),
  );

  if (object.snapshot === undefined && object.projections === undefined) {
    fail(path, 'expectation must include snapshot or projections');
  }

  const projectionCommandCount = commandKinds.filter((kind) =>
    PROJECTION_COMMANDS[kind] === true,
  ).length;
  const projectionExpectationCount = projections?.length ?? 0;
  if (projectionCommandCount !== projectionExpectationCount) {
    fail(
      path,
      `${projectionCommandCount} projection command(s) require ${projectionCommandCount} projection expectation(s); found ${projectionExpectationCount}`,
    );
  }
}

function collectTokenNames(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const match = TOKEN_PATTERN.exec(value);
    if (match) out.push(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTokenNames(entry, out);
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) collectTokenNames(entry, out);
  }
}

function assertKnownTokens(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const tokens: string[] = [];
  collectTokenNames(value, tokens);
  for (const token of tokens) {
    if (!allowed.has(token)) fail(path, `unknown capture token $${token}`);
  }
}

function validateCase(value: unknown, path: string): FixtureCase {
  const object = asObject(value, path);
  assertKnownKeys(object, CASE_KEYS, path);

  for (const required of ['id', 'purpose', 'clock', 'initial', 'commands', 'expect']) {
    if (!(required in object)) fail(path, `missing required field "${required}"`);
  }

  const id = requireString(object.id, `${path}.id`);
  if (!CASE_ID_PATTERN.test(id)) {
    fail(`${path}.id`, `invalid kebab-case id "${id}"`);
  }
  const purpose = requireString(object.purpose, `${path}.purpose`);
  if (purpose.trim().length === 0) fail(`${path}.purpose`, 'must not be empty');

  validateClock(object.clock, `${path}.clock`);

  if (object.requires !== undefined) {
    const requires = asArray(object.requires, `${path}.requires`);
    const seen = new Set<string>();
    requires.forEach((flag, index) => {
      const text = requireString(flag, `${path}.requires[${index}]`);
      if (CAPABILITY_FLAGS[text] !== true) {
        fail(`${path}.requires[${index}]`, `unknown capability flag "${text}"`);
      }
      if (seen.has(text)) {
        fail(`${path}.requires[${index}]`, `duplicate capability flag "${text}"`);
      }
      seen.add(text);
    });
  }

  if (object.divergence !== undefined) {
    const divergence = asObject(object.divergence, `${path}.divergence`);
    assertExactKeys(divergence, DIVERGENCE_KEYS, `${path}.divergence`);
    for (const key of DIVERGENCE_KEYS) {
      requireString(divergence[key], `${path}.divergence.${key}`);
    }
  }

  if (object.known_blocker !== undefined) {
    requireString(object.known_blocker, `${path}.known_blocker`);
  }

  validateSnapshot(object.initial, `${path}.initial`, 'initial');
  assertKnownTokens(object.initial, new Set<string>(), `${path}.initial`);

  const commands = asArray(object.commands, `${path}.commands`);
  const commandKinds: string[] = [];
  const capturesByCommand: string[][] = [];
  const declaredCaptures = new Set<string>();

  commands.forEach((command, index) => {
    const commandPath = `${path}.commands[${index}]`;
    const validated = validateCommand(command, commandPath);
    commandKinds.push(validated.kind);
    for (const name of validated.captureNames) {
      if (declaredCaptures.has(name)) {
        fail(commandPath, `capture name "${name}" is declared more than once in this case`);
      }
      declaredCaptures.add(name);
    }
    capturesByCommand.push(validated.captureNames);

    const allowedEarlier = new Set<string>();
    for (let prior = 0; prior < index; prior += 1) {
      for (const name of capturesByCommand[prior]) allowedEarlier.add(name);
    }
    assertKnownTokens(command, allowedEarlier, commandPath);
  });

  validateExpectation(object.expect, `${path}.expect`, commandKinds);
  assertKnownTokens(object.expect, declaredCaptures, `${path}.expect`);

  return value as FixtureCase;
}

function validateFixtureFile(
  value: unknown,
  expectedFile: FixtureFileName,
  path: string,
): FixtureFile {
  const object = asObject(value, path);
  assertExactKeys(object, ['protocol', 'file', 'title', 'cases'], path);

  if (object.protocol !== 1) fail(`${path}.protocol`, 'expected protocol 1');
  if (object.file !== expectedFile) {
    fail(`${path}.file`, `expected "${expectedFile}"`);
  }
  requireString(object.title, `${path}.title`);

  const cases = asArray(object.cases, `${path}.cases`);
  const seen = new Set<string>();
  cases.forEach((entry, index) => {
    const parsed = validateCase(entry, `${path}.cases[${index}]`);
    if (seen.has(parsed.id)) {
      fail(`${path}.cases[${index}].id`, `duplicate case id "${parsed.id}"`);
    }
    seen.add(parsed.id);
  });

  const expectedIds = EXPECTED_CASE_IDS[expectedFile];
  const expectedSet = new Set(expectedIds);
  const missing = expectedIds.filter((id) => !seen.has(id));
  const unexpected = [...seen].filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      path,
      `canonical case inventory mismatch; missing: [${missing.join(', ')}], unexpected: [${unexpected.join(', ')}]`,
    );
  }

  return value as FixtureFile;
}

export function resolveFixturesDirectory(override?: string): string {
  const defaultDirectory = fileURLToPath(
    new URL('../../../shared/finance-parity/', import.meta.url),
  );
  if (!override || override.trim().length === 0) return defaultDirectory;
  return isAbsolute(override) ? override : resolve(process.cwd(), override);
}

export interface FixtureLoadResult {
  files: FixtureFile[];
  directory: string;
}

export async function loadFixtures(override?: string): Promise<FixtureLoadResult> {
  const directory = resolveFixturesDirectory(override);
  const files: FixtureFile[] = [];
  const seenCaseIds = new Set<string>();

  for (const name of FIXTURE_FILE_NAMES) {
    const filePath = resolve(directory, `${name}.json`);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      throw new FixtureValidationError(
        `${filePath}: could not read fixture file (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new FixtureValidationError(
        `${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    const file = validateFixtureFile(parsed, name, filePath);
    for (const fixtureCase of file.cases) {
      if (seenCaseIds.has(fixtureCase.id)) {
        throw new FixtureValidationError(
          `${filePath}: case id "${fixtureCase.id}" is duplicated across fixture files`,
        );
      }
      seenCaseIds.add(fixtureCase.id);
    }
    files.push(file);
  }

  return { files, directory };
}

