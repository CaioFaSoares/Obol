// Canonical comparison view for the finance parity fixtures.
//
// This module normalizes only what the protocol documents: storage metadata is
// never included, optional flags/relations/money defaults are filled in, date
// text is normalized to UTC milliseconds, and money is compared as an exact
// decimal value. No business value is recomputed here.

import {
  canonicalDecimal,
  compareDecimal,
  compareIds,
  isMoneyString,
  moneyToProductNumber,
} from './decimal';
import {
  COLLECTION_NAMES,
  GENERATED_TITLE,
  SYNC_ENTITY_BY_COLLECTION,
  type CanonicalBudgetsProjection,
  type CanonicalForecastProjection,
  type CanonicalInvoiceTimelineProjection,
  type CanonicalProjection,
  type CanonicalProjectsProjection,
  type CanonicalRecord,
  type CanonicalSnapshot,
  type CanonicalValue,
  type CollectionName,
  type RawProjection,
  type RawRecord,
  type RawSnapshot,
} from './types';

type EntityType = (typeof SYNC_ENTITY_BY_COLLECTION)[CollectionName];

export type FieldKind =
  | 'text'
  | 'enum'
  | 'cadence'
  | 'money'
  | 'paid-money'
  | 'nullable-money'
  | 'instant'
  | 'relation'
  | 'bool'
  | 'int'
  | 'nullable-int'
  | 'period-list';

export interface FieldSpec {
  kind: FieldKind;
  values?: readonly string[];
}

export interface CollectionSpec {
  entityType: EntityType;
  fields: Record<string, FieldSpec>;
}

const ACCOUNT_TYPES = ['checking', 'savings', 'investment'] as const;
const CATEGORY_TYPES = ['fixed_budget', 'variable'] as const;
const INVOICE_STATUSES = ['OPEN', 'CLOSED', 'PAID'] as const;
const PROJECT_STATUSES = ['active', 'completed'] as const;
const RECURRENCE_TYPES = ['income', 'expense'] as const;
const RECURRENCE_STATUSES = ['active', 'paused', 'ended'] as const;
const TRANSACTION_TYPES = ['income', 'expense', 'transfer'] as const;
const TRANSACTION_STATUSES = ['pending', 'realized'] as const;

export const COLLECTION_SPECS: Record<CollectionName, CollectionSpec> = {
  accounts: {
    entityType: SYNC_ENTITY_BY_COLLECTION.accounts,
    fields: {
      name: { kind: 'text' },
      type: { kind: 'enum', values: ACCOUNT_TYPES },
      initial_balance: { kind: 'money' },
    },
  },
  cards: {
    entityType: SYNC_ENTITY_BY_COLLECTION.cards,
    fields: {
      name: { kind: 'text' },
      closing_day: { kind: 'int' },
      due_day: { kind: 'int' },
      limit: { kind: 'money' },
    },
  },
  categories: {
    entityType: SYNC_ENTITY_BY_COLLECTION.categories,
    fields: {
      name: { kind: 'text' },
      type: { kind: 'enum', values: CATEGORY_TYPES },
      monthly_budget: { kind: 'nullable-money' },
    },
  },
  invoices: {
    entityType: SYNC_ENTITY_BY_COLLECTION.invoices,
    fields: {
      card_id: { kind: 'relation' },
      period: { kind: 'text' },
      due_date: { kind: 'instant' },
      status: { kind: 'enum', values: INVOICE_STATUSES },
      total_amount: { kind: 'money' },
      paid_amount: { kind: 'paid-money' },
    },
  },
  projects: {
    entityType: SYNC_ENTITY_BY_COLLECTION.projects,
    fields: {
      name: { kind: 'text' },
      total_value: { kind: 'money' },
      status: { kind: 'enum', values: PROJECT_STATUSES },
    },
  },
  recurrences: {
    entityType: SYNC_ENTITY_BY_COLLECTION.recurrences,
    fields: {
      name: { kind: 'text' },
      amount: { kind: 'money' },
      payday: { kind: 'int' },
      type: { kind: 'enum', values: RECURRENCE_TYPES },
      status: { kind: 'enum', values: RECURRENCE_STATUSES },
      frequency: { kind: 'cadence' },
      weekday: { kind: 'nullable-int' },
      account_id: { kind: 'relation' },
      card_id: { kind: 'relation' },
      category_id: { kind: 'relation' },
      end_date: { kind: 'instant' },
      total_installments: { kind: 'nullable-int' },
      skipped_periods: { kind: 'period-list' },
    },
  },
  transactions: {
    entityType: SYNC_ENTITY_BY_COLLECTION.transactions,
    fields: {
      title: { kind: 'text' },
      amount: { kind: 'money' },
      type: { kind: 'enum', values: TRANSACTION_TYPES },
      status: { kind: 'enum', values: TRANSACTION_STATUSES },
      expected_date: { kind: 'instant' },
      realized_date: { kind: 'instant' },
      purchase_date: { kind: 'instant' },
      is_recurring: { kind: 'bool' },
      is_silent: { kind: 'bool' },
      is_simulated: { kind: 'bool' },
      is_scheduled: { kind: 'bool' },
      account_id: { kind: 'relation' },
      card_id: { kind: 'relation' },
      category_id: { kind: 'relation' },
      project_id: { kind: 'relation' },
      invoice_id: { kind: 'relation' },
      recurrence_id: { kind: 'relation' },
      destination_account_id: { kind: 'relation' },
    },
  },
};

/** Fields required in a complete snapshot record. */
export const REQUIRED_RECORD_FIELDS: Readonly<Record<CollectionName, readonly string[]>> = {
  accounts: ['id', 'name', 'type', 'initial_balance'],
  cards: ['id', 'name', 'closing_day', 'due_day', 'limit'],
  categories: ['id', 'name', 'type'],
  invoices: ['id', 'card_id', 'period', 'due_date', 'status', 'total_amount'],
  projects: ['id', 'name', 'total_value', 'status'],
  recurrences: ['id', 'name', 'amount', 'payday', 'type', 'status'],
  transactions: ['id', 'title', 'amount', 'type', 'status', 'expected_date'],
};

/** Fields a create use case supplies itself, so a create intent may omit them. */
export const CREATE_DEFAULTED_FIELDS: Readonly<Record<CollectionName, readonly string[]>> = {
  accounts: [],
  cards: [],
  categories: [],
  invoices: [],
  projects: [],
  recurrences: ['status'],
  transactions: [],
};

export type NormalizationOrigin = 'expected' | 'actual';

const STRICT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOOSE_INSTANT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path}: expected a string, got ${typeof value}`);
  }
  return value;
}

/** Normalizes a fixture instant (strict) or a PocketBase date (lenient). */
export function normalizeInstant(
  value: unknown,
  origin: NormalizationOrigin,
  path: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path}: expected an ISO instant`);
  }
  if (origin === 'expected' && !STRICT_INSTANT.test(value)) {
    throw new Error(`${path}: expected an ISO UTC millisecond instant, got "${value}"`);
  }
  const match = LOOSE_INSTANT.exec(value);
  if (!match) {
    throw new Error(`${path}: expected a UTC instant, got "${value}"`);
  }
  const fraction = (match[3] ?? '').padEnd(3, '0').slice(0, 3);
  const target = `${match[1]}T${match[2]}.${fraction}Z`;
  const date = new Date(target);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${path}: invalid instant "${value}"`);
  }
  if (date.toISOString() !== target) {
    throw new Error(`${path}: non-calendar instant "${value}"`);
  }
  return target;
}

export function normalizeInstantOrNull(
  value: unknown,
  origin: NormalizationOrigin,
  path: string,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  return normalizeInstant(value, origin, path);
}

export function normalizeDay(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
    throw new Error(`${path}: expected YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || !date.toISOString().startsWith(value)) {
    throw new Error(`${path}: invalid calendar day "${value}"`);
  }
  return value;
}

export function normalizePeriod(value: unknown, path: string): string {
  if (typeof value !== 'string' || !PERIOD_PATTERN.test(value)) {
    throw new Error(`${path}: expected YYYY-MM, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Period identity held by a recurrence's `skipped_periods`: `YYYY-MM` for a
 * monthly skip and `YYYY-MM-DD` for a weekly occurrence day (D019).
 */
export function normalizePeriodOrDay(value: unknown, path: string): string {
  if (typeof value === 'string' && DAY_PATTERN.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)) return value;
    throw new Error(`${path}: invalid calendar day "${value}"`);
  }
  return normalizePeriod(value, path);
}

function canonicalMoney(value: unknown, origin: NormalizationOrigin, path: string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path}: money is not finite`);
    }
    return canonicalDecimal(value);
  }
  if (typeof value === 'string') {
    if (origin === 'expected' && !isMoneyString(value)) {
      throw new Error(`${path}: expected a decimal money string, got "${value}"`);
    }
    return canonicalDecimal(value);
  }
  throw new Error(`${path}: money must be a decimal string or number`);
}

function canonicalField(
  field: string,
  spec: FieldSpec,
  value: unknown,
  origin: NormalizationOrigin,
  path: string,
): CanonicalValue {
  switch (spec.kind) {
    case 'text': {
      const text = requireString(value, path);
      return text;
    }
    case 'enum': {
      const text = requireString(value, path);
      if (spec.values && !spec.values.includes(text)) {
        throw new Error(`${path}: value "${text}" is not one of ${spec.values.join(', ')}`);
      }
      return text;
    }
    case 'cadence': {
      // Absent and the blank select value both mean the historical monthly
      // cadence, so a monthly row compares equal whether it stores `monthly`
      // or nothing at all.
      if (value === null || value === undefined || value === '') return 'monthly';
      const text = requireString(value, path);
      if (text !== 'monthly' && text !== 'weekly') {
        throw new Error(`${path}: cadence "${text}" is not monthly or weekly`);
      }
      return text;
    }
    case 'money':
      return canonicalMoney(value, origin, path);
    case 'paid-money': {
      if (value === null || value === undefined || value === '') return '0';
      return canonicalMoney(value, origin, path);
    }
    case 'nullable-money': {
      if (value === null || value === undefined || value === '') return null;
      const canonical = canonicalMoney(value, origin, path);
      // PocketBase number fields return 0 for an unset optional value. The
      // protocol treats monthly_budget null and absent as equal; the storage
      // layer cannot distinguish unset from an explicit zero, so an actual
      // zero collapses to null. Expected fixtures keep an explicit zero.
      if (origin === 'actual' && canonical === '0') return null;
      return canonical;
    }
    case 'instant':
      return normalizeInstantOrNull(value, origin, path);
    case 'relation': {
      if (value === null || value === undefined || value === '') return null;
      return requireString(value, path);
    }
    case 'bool': {
      if (value === null || value === undefined) return false;
      if (typeof value !== 'boolean') {
        throw new Error(`${path}: expected a boolean, got ${typeof value}`);
      }
      return value;
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${path}: expected an integer, got ${JSON.stringify(value)}`);
      }
      return value;
    }
    case 'nullable-int': {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${path}: expected an integer or null, got ${JSON.stringify(value)}`);
      }
      if (origin === 'actual' && value === 0) return null;
      return value;
    }
    case 'period-list': {
      if (value === null || value === undefined || value === '') return [];
      let list: unknown = value;
      if (typeof value === 'string') {
        try {
          list = JSON.parse(value);
        } catch {
          throw new Error(`${path}: expected a period array, got "${value}"`);
        }
      }
      if (!Array.isArray(list)) {
        throw new Error(`${path}: expected a period array`);
      }
      const periods = list.map((entry, index) =>
        normalizePeriodOrDay(entry, `${path}[${index}]`),
      );
      periods.sort(compareIds);
      return periods;
    }
    default:
      throw new Error(`${path}: unsupported field kind for "${field}"`);
  }
}

export function canonicalizeRecord(
  record: RawRecord,
  collection: CollectionName,
  origin: NormalizationOrigin,
): CanonicalRecord {
  const spec = COLLECTION_SPECS[collection];
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${collection}: record is missing its id`);
  }
  if (id.startsWith('$')) {
    throw new Error(`${collection}: unresolved capture token "${id}"`);
  }

  const out: CanonicalRecord = { id };
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    out[field] = canonicalField(
      field,
      fieldSpec,
      record[field],
      origin,
      `${collection}.${id}.${field}`,
    );
  }
  return out;
}

export function canonicalizeSnapshot(
  snapshot: RawSnapshot,
  origin: NormalizationOrigin,
): CanonicalSnapshot {
  const out = {} as CanonicalSnapshot;
  for (const collection of COLLECTION_NAMES) {
    const rows = snapshot[collection];
    if (!Array.isArray(rows)) {
      throw new Error(`${collection}: snapshot entry is not an array`);
    }
    const records = rows.map((row) => canonicalizeRecord(row, collection, origin));
    records.sort((left, right) => compareIds(left.id, right.id));
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        throw new Error(`${collection}: duplicate record id "${record.id}"`);
      }
      seen.add(record.id);
    }
    out[collection] = records;
  }
  return out;
}

/** Canonical form of a capture `where` clause. */
export function canonicalizeWhere(
  where: Record<string, unknown>,
  collection: CollectionName,
  origin: NormalizationOrigin,
): Record<string, CanonicalValue> {
  const spec = COLLECTION_SPECS[collection];
  const out: Record<string, CanonicalValue> = {};
  for (const [field, value] of Object.entries(where)) {
    if (field === 'id') {
      out.id = requireString(value, `${collection}.where.id`);
      continue;
    }
    const fieldSpec = spec.fields[field];
    if (!fieldSpec) {
      throw new Error(`${collection}.where: unknown field "${field}"`);
    }
    out[field] = canonicalField(
      field,
      fieldSpec,
      value,
      origin,
      `${collection}.where.${field}`,
    );
  }
  return out;
}

const CAPTURE_TOKEN_PATTERN = /^\$([a-z][a-z0-9]*)$/;

export function resolveTokens<T>(value: T, captures: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') {
    const match = CAPTURE_TOKEN_PATTERN.exec(value);
    if (match) {
      const resolved = captures.get(match[1]);
      if (resolved !== undefined) return resolved as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTokens(entry, captures)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = resolveTokens(entry, captures);
    }
    return out as unknown as T;
  }
  return value;
}

export function findUnresolvedCaptureTokens(
  value: unknown,
  captures: ReadonlyMap<string, string>,
): string[] {
  const found: string[] = [];
  const walk = (entry: unknown): void => {
    if (typeof entry === 'string') {
      const match = CAPTURE_TOKEN_PATTERN.exec(entry);
      if (match && !captures.has(match[1])) found.push(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) walk(child);
      return;
    }
    if (isPlainObject(entry)) {
      for (const child of Object.values(entry)) walk(child);
    }
  };
  walk(value);
  return found;
}

// ---------------------------------------------------------------------------
// Fixture record -> PocketBase storage payload
// ---------------------------------------------------------------------------

const OMIT = Symbol('omit-field');

function mapFieldForStorage(value: unknown, spec: FieldSpec): unknown | typeof OMIT {
  switch (spec.kind) {
    case 'money':
      return moneyToProductNumber(requireString(value, 'storage.money'));
    case 'paid-money':
    case 'nullable-money':
      if (value === null || value === undefined || value === '') return OMIT;
      return moneyToProductNumber(requireString(value, 'storage.money'));
    case 'instant':
      if (value === null || value === undefined || value === '') return OMIT;
      return requireString(value, 'storage.instant');
    case 'relation':
      if (value === null || value === undefined || value === '') return OMIT;
      return requireString(value, 'storage.relation');
    case 'bool':
      return Boolean(value);
    case 'int':
    case 'nullable-int':
      if (value === null || value === undefined || value === '') return OMIT;
      return value;
    case 'period-list':
      if (value === null || value === undefined || value === '') return OMIT;
      return value;
    case 'text':
    case 'enum':
      return requireString(value, 'storage.text');
    case 'cadence':
      if (value === null || value === undefined || value === '') return OMIT;
      return requireString(value, 'storage.cadence');
    default:
      return OMIT;
  }
}

/** Maps a fixture record's intent fields (no id) to product input fields. */
export function mapIntentRecord(
  record: RawRecord,
  collection: CollectionName,
): Record<string, unknown> {
  const spec = COLLECTION_SPECS[collection];
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    if (field === 'id') continue;
    const fieldSpec = spec.fields[field];
    if (!fieldSpec) {
      throw new Error(`${collection}: unknown field "${field}"`);
    }
    if (value === null) {
      // A command intent keeps an explicit null so a partial patch can clear a
      // relation or date; booleans normalize to false. Optional numeric/JSON
      // fields are omitted because their null and absent forms are equal.
      if (fieldSpec.kind === 'bool') {
        out[field] = false;
        continue;
      }
      if (
        fieldSpec.kind === 'nullable-int' ||
        fieldSpec.kind === 'nullable-money' ||
        fieldSpec.kind === 'paid-money' ||
        fieldSpec.kind === 'period-list' ||
        fieldSpec.kind === 'cadence'
      ) {
        continue;
      }
      out[field] = null;
      continue;
    }
    const mapped = mapFieldForStorage(value, fieldSpec);
    if (mapped !== OMIT) out[field] = mapped;
  }
  return out;
}

/** Maps a settled snapshot record, including its id, to a PB batch payload. */
export function mapRecordForStorage(
  record: RawRecord,
  collection: CollectionName,
): Record<string, unknown> {
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${collection}: initial record is missing its id`);
  }

  const spec = COLLECTION_SPECS[collection];
  const out: Record<string, unknown> = { id };
  for (const [field, value] of Object.entries(record)) {
    if (field === 'id') continue;
    const fieldSpec = spec.fields[field];
    if (!fieldSpec) {
      throw new Error(`${collection}: unknown field "${field}"`);
    }
    // A settled snapshot uses absent/null for an unset storage value; never
    // send null to a PocketBase date, relation or number column.
    if (value === null) continue;
    const mapped = mapFieldForStorage(value, fieldSpec);
    if (mapped !== OMIT) out[field] = mapped;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  let text: string;
  try {
    const encoded = JSON.stringify(value);
    text = encoded === undefined ? String(value) : encoded;
  } catch {
    text = String(value);
  }
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function joinPath(base: string, key: string): string {
  return base.length === 0 ? key : `${base}.${key}`;
}

export function collectDeepDiff(
  expected: unknown,
  actual: unknown,
  path: string,
  out: string[],
  limit = 60,
): void {
  if (out.length >= limit) return;

  if (expected === actual) return;

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push(`${path}: expected ${formatValue(expected)} actual ${formatValue(actual)}`);
      return;
    }
    if (expected.length !== actual.length) {
      out.push(`${path}.length: expected ${expected.length} actual ${actual.length}`);
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length && out.length < limit; index += 1) {
      collectDeepDiff(expected[index], actual[index], `${path}[${index}]`, out, limit);
    }
    return;
  }

  if (isPlainObject(expected) || isPlainObject(actual)) {
    if (!isPlainObject(expected) || !isPlainObject(actual)) {
      out.push(`${path}: expected ${formatValue(expected)} actual ${formatValue(actual)}`);
      return;
    }
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    for (const key of expectedKeys) {
      if (out.length >= limit) return;
      if (!Object.prototype.hasOwnProperty.call(actual, key)) {
        out.push(`${joinPath(path, key)}: expected ${formatValue(expected[key])} actual <missing>`);
        continue;
      }
      collectDeepDiff(expected[key], actual[key], joinPath(path, key), out, limit);
    }
    for (const key of actualKeys) {
      if (out.length >= limit) return;
      if (!Object.prototype.hasOwnProperty.call(expected, key)) {
        out.push(`${joinPath(path, key)}: expected <absent> actual ${formatValue(actual[key])}`);
      }
    }
    return;
  }

  out.push(`${path}: expected ${formatValue(expected)} actual ${formatValue(actual)}`);
}

/**
 * Canonical field values are primitives, `null`, or sorted string arrays
 * (period lists). Two canonicalized arrays — e.g. two empty `skipped_periods`
 * lists — are reference-distinct instances of the same value, so comparison
 * must be structural, never strict.
 */
function canonicalValueEquals(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diffs: string[] = [];
    collectDeepDiff(expected, actual, '', diffs);
    return diffs.length === 0;
  }
  return false;
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function compareSnapshots(
  expected: CanonicalSnapshot,
  actual: CanonicalSnapshot,
): string[] {
  const diffs: string[] = [];
  for (const collection of COLLECTION_NAMES) {
    const expectedRows = expected[collection];
    const actualRows = actual[collection];
    const expectedById = new Map(
      expectedRows.map((row): [string, CanonicalRecord] => [row.id, row]),
    );
    const actualById = new Map(
      actualRows.map((row): [string, CanonicalRecord] => [row.id, row]),
    );
    const ids = [...new Set([...expectedById.keys(), ...actualById.keys()])].sort(compareIds);

    for (const id of ids) {
      const expectedRow = expectedById.get(id);
      const actualRow = actualById.get(id);
      if (!expectedRow) {
        diffs.push(`${collection}: unexpected record "${id}"`);
        continue;
      }
      if (!actualRow) {
        diffs.push(`${collection}: missing record "${id}"`);
        continue;
      }
      for (const field of Object.keys(COLLECTION_SPECS[collection].fields)) {
        const expectedValue = expectedRow[field];
        const actualValue = actualRow[field];
        if (field === 'title' && expectedValue === GENERATED_TITLE) {
          if (typeof actualValue !== 'string' || actualValue.length === 0) {
            diffs.push(
              `${collection}.${id}.title: expected any non-empty title, actual ${formatValue(actualValue)}`,
            );
          }
          continue;
        }
        if (!canonicalValueEquals(expectedValue, actualValue)) {
          diffs.push(
            `${collection}.${id}.${field}: expected ${formatValue(expectedValue)} (${describeValueType(expectedValue)}) actual ${formatValue(actualValue)} (${describeValueType(actualValue)})`,
          );
        }
      }
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Projection canonicalization
// ---------------------------------------------------------------------------

function reqObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${path}: expected an object`);
  return value;
}

function reqArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
  return value;
}

function reqBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path}: expected a boolean`);
  return value;
}

function reqMoney(value: unknown, origin: NormalizationOrigin, path: string): string {
  return canonicalMoney(value, origin, path);
}

function reqInstant(value: unknown, origin: NormalizationOrigin, path: string): string {
  return normalizeInstant(value, origin, path);
}

function canonicalizeForecast(
  raw: Record<string, unknown>,
  origin: NormalizationOrigin,
): CanonicalForecastProjection {
  const timeline = reqArray(raw.timeline, 'forecast.timeline').map((entry, index) => {
    const object = reqObject(entry, `forecast.timeline[${index}]`);
    return {
      date: normalizeDay(object.date, `forecast.timeline[${index}].date`),
      balance: reqMoney(object.balance, origin, `forecast.timeline[${index}].balance`),
    };
  });

  const upcoming = reqArray(
    raw.upcoming_invoices,
    'forecast.upcoming_invoices',
  ).map((entry, index) => {
    const object = reqObject(entry, `forecast.upcoming_invoices[${index}]`);
    return {
      card_id: requireString(
        object.card_id,
        `forecast.upcoming_invoices[${index}].card_id`,
      ),
      card_name: requireString(
        object.card_name,
        `forecast.upcoming_invoices[${index}].card_name`,
      ),
      due_date: reqInstant(
        object.due_date,
        origin,
        `forecast.upcoming_invoices[${index}].due_date`,
      ),
      amount_due: reqMoney(
        object.amount_due,
        origin,
        `forecast.upcoming_invoices[${index}].amount_due`,
      ),
      status: requireString(
        object.status,
        `forecast.upcoming_invoices[${index}].status`,
      ),
    };
  });

  return {
    kind: 'forecast',
    start_date: normalizeDay(raw.start_date, 'forecast.start_date'),
    end_date: normalizeDay(raw.end_date, 'forecast.end_date'),
    include_simulations: reqBoolean(
      raw.include_simulations,
      'forecast.include_simulations',
    ),
    timeline,
    upcoming_invoices: upcoming,
    first_negative_date:
      raw.first_negative_date === null || raw.first_negative_date === undefined
        ? null
        : reqInstant(raw.first_negative_date, origin, 'forecast.first_negative_date'),
  };
}

function canonicalizeBudgets(
  raw: Record<string, unknown>,
  origin: NormalizationOrigin,
): CanonicalBudgetsProjection {
  const categories = reqArray(raw.categories, 'budgets.categories').map(
    (entry, index) => {
      const object = reqObject(entry, `budgets.categories[${index}]`);
      return {
        category_id: requireString(
          object.category_id,
          `budgets.categories[${index}].category_id`,
        ),
        monthly_budget: reqMoney(
          object.monthly_budget,
          origin,
          `budgets.categories[${index}].monthly_budget`,
        ),
        spent: reqMoney(object.spent, origin, `budgets.categories[${index}].spent`),
      };
    },
  );

  return {
    kind: 'budgets',
    as_of: reqInstant(raw.as_of, origin, 'budgets.as_of'),
    categories,
  };
}

function canonicalizeProjects(
  raw: Record<string, unknown>,
  origin: NormalizationOrigin,
): CanonicalProjectsProjection {
  const projects = reqArray(raw.projects, 'projects.projects').map((entry, index) => {
    const object = reqObject(entry, `projects.projects[${index}]`);
    return {
      project_id: requireString(
        object.project_id,
        `projects.projects[${index}].project_id`,
      ),
      status: requireString(object.status, `projects.projects[${index}].status`),
      total_value: reqMoney(
        object.total_value,
        origin,
        `projects.projects[${index}].total_value`,
      ),
      paid: reqMoney(object.paid, origin, `projects.projects[${index}].paid`),
      remaining: reqMoney(
        object.remaining,
        origin,
        `projects.projects[${index}].remaining`,
      ),
    };
  });

  return { kind: 'projects', projects };
}

function canonicalizeInvoiceTimeline(
  raw: Record<string, unknown>,
  origin: NormalizationOrigin,
): CanonicalInvoiceTimelineProjection {
  const invoices = reqArray(raw.invoices, 'invoice_timeline.invoices').map(
    (entry, invoiceIndex) => {
      const invoicePath = `invoice_timeline.invoices[${invoiceIndex}]`;
      const object = reqObject(entry, invoicePath);
      const lines = reqArray(object.lines, `${invoicePath}.lines`).map(
        (lineEntry, lineIndex) => {
          const linePath = `${invoicePath}.lines[${lineIndex}]`;
          const line = reqObject(lineEntry, linePath);
          const status = requireString(line.status, `${linePath}.status`);
          const out: {
            id?: string;
            amount: string;
            status: string;
            expected_date: string;
            purchase_date?: string;
            recurrence_id?: string;
          } = {
            amount: reqMoney(line.amount, origin, `${linePath}.amount`),
            status,
            expected_date: reqInstant(
              line.expected_date,
              origin,
              `${linePath}.expected_date`,
            ),
          };

          // Projected lines never expose a derived id or title.
          if (
            status !== 'projected' &&
            line.id !== null &&
            line.id !== undefined &&
            line.id !== ''
          ) {
            out.id = requireString(line.id, `${linePath}.id`);
          }
          if (
            line.purchase_date !== null &&
            line.purchase_date !== undefined &&
            line.purchase_date !== ''
          ) {
            out.purchase_date = reqInstant(
              line.purchase_date,
              origin,
              `${linePath}.purchase_date`,
            );
          }
          if (
            line.recurrence_id !== null &&
            line.recurrence_id !== undefined &&
            line.recurrence_id !== ''
          ) {
            out.recurrence_id = requireString(
              line.recurrence_id,
              `${linePath}.recurrence_id`,
            );
          }
          return out;
        },
      );

      return {
        period: normalizePeriod(object.period, `${invoicePath}.period`),
        due_date: reqInstant(object.due_date, origin, `${invoicePath}.due_date`),
        status: requireString(object.status, `${invoicePath}.status`),
        debt: reqMoney(object.debt, origin, `${invoicePath}.debt`),
        paid_amount: reqMoney(
          object.paid_amount,
          origin,
          `${invoicePath}.paid_amount`,
        ),
        total_spent: reqMoney(
          object.total_spent,
          origin,
          `${invoicePath}.total_spent`,
        ),
        lines,
      };
    },
  );

  return {
    kind: 'invoice_timeline',
    card_id: requireString(raw.card_id, 'invoice_timeline.card_id'),
    invoices,
  };
}

export function canonicalizeProjection(
  raw: RawProjection,
  origin: NormalizationOrigin,
): CanonicalProjection {
  const object = raw as unknown as Record<string, unknown>;
  const kind = requireString(object.kind, 'projection.kind');
  switch (kind) {
    case 'forecast':
      return canonicalizeForecast(object, origin);
    case 'budgets':
      return canonicalizeBudgets(object, origin);
    case 'projects':
      return canonicalizeProjects(object, origin);
    case 'invoice_timeline':
      return canonicalizeInvoiceTimeline(object, origin);
    default:
      throw new Error(`projection: unsupported kind "${kind}"`);
  }
}

export function compareProjections(
  expected: CanonicalProjection[],
  actual: CanonicalProjection[],
): string[] {
  const diffs: string[] = [];
  if (expected.length !== actual.length) {
    diffs.push(
      `projections.length: expected ${expected.length} actual ${actual.length}`,
    );
  }
  const length = Math.min(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    collectDeepDiff(
      expected[index],
      actual[index],
      `projections[${index}]`,
      diffs,
      60,
    );
  }
  return diffs;
}

/** True when the exact monetary value is negative. */
export function isNegativeMoney(value: string): boolean {
  return compareDecimal(value, '0') < 0;
}
