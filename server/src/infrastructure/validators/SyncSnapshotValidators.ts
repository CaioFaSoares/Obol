// Snapshot wire validators for `POST /api/sync/seed` and
// `POST /api/sync/import` (D016 D4 seed, D7 import-as-new). Pure TypeScript.
//
// The snapshot object keeps the PocketBase collection names (plural arrays).
// Row validation is keyed by the singular entity type. Unknown fields are
// rejected; raw JSON values are validated without coercion, so the six-field
// import hash is computed over exactly the values the client sent.
//
// Completeness rules:
// - exactly the seven financial collections; complete stored row shapes; no
//   unknown row fields;
// - every row id is a canonical 15-character lowercase PocketBase id and is
//   unique inside its own collection (cross-collection reuse is legal);
// - every non-empty relation must resolve inside the same snapshot — no
//   dangling references and no server lookups;
// - nothing recomputes a financial value or deduplicates by amount.

import {
  SYNC_COLLECTIONS,
  SYNC_ENTITY_TYPES,
  isSyncEntityId,
  type SyncCollectionName,
  type SyncEntityType,
  type SyncJsonValue,
  type SyncSha256Hash,
} from '../../domain/sync/SyncRevision';
import type { SyncImportRequest, SyncSeedRequest, SyncSeedSnapshot } from '../../domain/sync/SyncProtocol';
import {
  SYNC_IMPORT_HASH_FIELDS,
  SYNC_IMPORT_MAX_ROWS,
  SYNC_SEED_MAX_ROWS,
  SyncProtocolRequestError,
  isSyncUuid,
  isSyncUuidV7,
} from '../../domain/sync/SyncProtocol';
import {
  canonicalHash,
  isSyncSha256Hash,
  normalizeSyncTimestamp,
  toSyncJsonValue,
} from '../sync/CanonicalJson';

type JsonBox = { [key: string]: unknown };
type FieldCheck = (value: unknown, context: string) => void;

const COLLECTION_KEYS = Object.values(SYNC_COLLECTIONS) as readonly SyncCollectionName[];

const ACCOUNT_TYPES: readonly string[] = ['checking', 'savings', 'investment'];
const CATEGORY_TYPES: readonly string[] = ['fixed_budget', 'variable'];
const FINANCE_TYPES: readonly string[] = ['income', 'expense'];
const TRANSACTION_TYPES: readonly string[] = [...FINANCE_TYPES, 'transfer'];
const TRANSACTION_STATUSES: readonly string[] = ['pending', 'realized'];
const PROJECT_STATUSES: readonly string[] = ['active', 'completed'];
const RECURRENCE_STATUSES: readonly string[] = ['active', 'paused', 'ended'];
const RECURRENCE_FREQUENCIES: readonly string[] = ['monthly', 'weekly'];
const INVOICE_STATUSES: readonly string[] = ['OPEN', 'CLOSED', 'PAID'];

function literalOf(value: unknown, allowed: readonly string[], context: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`${context} must be one of ${allowed.join(' | ')}`);
  }
}

function nonEmptyString(value: unknown, context: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
}

function finiteNumber(value: unknown, context: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite JSON number`);
  }
}

function positiveAmount(value: unknown, context: string): void {
  finiteNumber(value, context);
  if ((value as number) <= 0) {
    throw new TypeError(`${context} must be greater than zero`);
  }
}

function nonNegativeNumber(value: unknown, context: string): void {
  finiteNumber(value, context);
  if ((value as number) < 0) {
    throw new TypeError(`${context} must be zero or greater`);
  }
}

function integerWithin(value: unknown, min: number, max: number, context: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${context} must be an integer within ${min}..${max}`);
  }
}

function booleanField(value: unknown, context: string): void {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${context} must be a boolean`);
  }
}

/**
 * Required stored date: PocketBase accepts the RFC3339 form and the stored
 * space-separated form. A bare calendar date is accepted too because exported
 * finance rows can carry `YYYY-MM-DD` for date-only fields.
 */
function requiredDate(value: unknown, context: string): void {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
      throw new TypeError(`${context} is not a valid calendar date`);
    }
    return;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${context} must be an ISO date string`);
  }
  try {
    normalizeSyncTimestamp(value, context);
  } catch (error) {
    throw new TypeError(
      `${context} is not an ISO-8601 timestamp: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Optional stored date: the empty string is PocketBase's "unset" value. */
function optionalDate(value: unknown, context: string): void {
  if (value === '') return;
  requiredDate(value, context);
}

/**
 * Audit timestamps the native models encode on every entity (Swift
 * `created`/`updated`, server domain entities) and PocketBase stores itself.
 * They are optional because a never-synced native row has none yet, but when
 * present they must be real dates; nothing here rewrites or recomputes them.
 */
const SNAPSHOT_AUDIT_FIELDS: Readonly<Record<string, FieldCheck>> = {
  created: requiredDate,
  updated: requiredDate,
};

/** Required relation id (non-empty 15-character id). */
function requiredRelation(value: unknown, context: string): void {
  if (typeof value !== 'string' || !isSyncEntityId(value)) {
    throw new TypeError(`${context} must be a 15-character lowercase id`);
  }
}

/** Optional relation: empty string means unset. */
function optionalRelation(value: unknown, context: string): void {
  if (typeof value !== 'string' || (value !== '' && !isSyncEntityId(value))) {
    throw new TypeError(`${context} must be a 15-character lowercase id or the empty string`);
  }
}

/**
 * Period identity: `YYYY-MM` for invoice and monthly recurrence periods, and
 * `YYYY-MM-DD` for the weekly recurrence skip keys stored in the same array.
 */
function periodString(value: unknown, context: string): void {
  if (typeof value !== 'string') {
    throw new TypeError(`${context} must be a YYYY-MM period or a YYYY-MM-DD day key`);
  }
  if (/^\d{4}-\d{2}$/.test(value)) return;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(day.getTime()) && day.toISOString().startsWith(value)) return;
  }
  throw new TypeError(`${context} must be a YYYY-MM period or a YYYY-MM-DD day key`);
}

function periodArrayField(value: unknown, context: string): void {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${context} must be an array of YYYY-MM periods or YYYY-MM-DD day keys`,
    );
  }
  value.forEach((entry, index) => periodString(entry, `${context}[${String(index)}]`));
}

/** Cadence select: the blank storage value means monthly (D019). */
function recurrenceFrequency(value: unknown, context: string): void {
  if (typeof value !== 'string' || (value !== '' && !RECURRENCE_FREQUENCIES.includes(value))) {
    throw new TypeError(`${context} must be monthly or weekly`);
  }
}

/** `required`, `optional` and `nullable` describe stored field classes. */
interface SnapshotRowSpec {
  readonly required: Readonly<Record<string, FieldCheck>>;
  readonly optional: Readonly<Record<string, FieldCheck>>;
  readonly nullable: Readonly<Record<string, FieldCheck>>;
}

const SNAPSHOT_ROW_SPECS: Record<SyncEntityType, SnapshotRowSpec> = {
  account: {
    required: {
      name: nonEmptyString,
      type: (value, context) => literalOf(value, ACCOUNT_TYPES, context),
      initial_balance: finiteNumber,
    },
    optional: { ...SNAPSHOT_AUDIT_FIELDS },
    nullable: {},
  },
  card: {
    required: {
      name: nonEmptyString,
      closing_day: (value, context) => integerWithin(value, 1, 31, context),
      due_day: (value, context) => integerWithin(value, 1, 31, context),
      limit: nonNegativeNumber,
    },
    optional: { ...SNAPSHOT_AUDIT_FIELDS },
    nullable: {},
  },
  category: {
    required: {
      name: nonEmptyString,
      type: (value, context) => literalOf(value, CATEGORY_TYPES, context),
    },
    optional: { monthly_budget: nonNegativeNumber, ...SNAPSHOT_AUDIT_FIELDS },
    nullable: { monthly_budget: nonNegativeNumber },
  },
  invoice: {
    required: {
      card_id: requiredRelation,
      period: periodString,
      due_date: requiredDate,
      status: (value, context) => literalOf(value, INVOICE_STATUSES, context),
      total_amount: finiteNumber,
    },
    optional: { paid_amount: nonNegativeNumber, ...SNAPSHOT_AUDIT_FIELDS },
    nullable: { paid_amount: nonNegativeNumber },
  },
  project: {
    required: {
      name: nonEmptyString,
      total_value: nonNegativeNumber,
      status: (value, context) => literalOf(value, PROJECT_STATUSES, context),
    },
    optional: { ...SNAPSHOT_AUDIT_FIELDS },
    nullable: {},
  },
  recurrence: {
    required: {
      name: nonEmptyString,
      amount: positiveAmount,
      payday: (value, context) => integerWithin(value, 1, 31, context),
      type: (value, context) => literalOf(value, FINANCE_TYPES, context),
      status: (value, context) => literalOf(value, RECURRENCE_STATUSES, context),
    },
    optional: {
      frequency: recurrenceFrequency,
      weekday: (value, context) => integerWithin(value, 0, 7, context),
      account_id: optionalRelation,
      card_id: optionalRelation,
      category_id: optionalRelation,
      end_date: optionalDate,
      total_installments: (value, context) =>
        integerWithin(value, 0, Number.MAX_SAFE_INTEGER, context),
      skipped_periods: periodArrayField,
      ...SNAPSHOT_AUDIT_FIELDS,
    },
    nullable: {
      end_date: requiredDate,
      total_installments: (value, context) =>
        integerWithin(value, 1, Number.MAX_SAFE_INTEGER, context),
      skipped_periods: periodArrayField,
    },
  },
  transaction: {
    required: {
      title: nonEmptyString,
      amount: positiveAmount,
      type: (value, context) => literalOf(value, TRANSACTION_TYPES, context),
      status: (value, context) => literalOf(value, TRANSACTION_STATUSES, context),
      expected_date: requiredDate,
    },
    optional: {
      account_id: optionalRelation,
      card_id: optionalRelation,
      category_id: optionalRelation,
      project_id: optionalRelation,
      destination_account_id: optionalRelation,
      invoice_id: optionalRelation,
      recurrence_id: optionalRelation,
      purchase_date: optionalDate,
      realized_date: optionalDate,
      is_recurring: booleanField,
      is_silent: booleanField,
      is_simulated: booleanField,
      is_scheduled: booleanField,
      ...SNAPSHOT_AUDIT_FIELDS,
    },
    nullable: {},
  },
};

const SNAPSHOT_RELATION_TARGETS: Record<
  SyncEntityType,
  ReadonlyArray<readonly [string, SyncEntityType]>
> = {
  account: [],
  card: [],
  category: [],
  invoice: [['card_id', 'card']],
  project: [],
  recurrence: [
    ['account_id', 'account'],
    ['card_id', 'card'],
    ['category_id', 'category'],
  ],
  transaction: [
    ['account_id', 'account'],
    ['card_id', 'card'],
    ['category_id', 'category'],
    ['project_id', 'project'],
    ['destination_account_id', 'account'],
    ['invoice_id', 'invoice'],
    ['recurrence_id', 'recurrence'],
  ],
};

export interface ValidatedSnapshot {
  readonly snapshot: SyncSeedSnapshot;
  /** Per-collection row counts keyed by singular entity type. */
  readonly counts: Readonly<Record<SyncEntityType, number>>;
}

/** The declared field names of one row, in a stable order. */
function allowedRowFields(spec: SnapshotRowSpec): readonly string[] {
  return [
    'id',
    ...Object.keys(spec.required),
    ...Object.keys(spec.optional),
    ...Object.keys(spec.nullable),
  ];
}

function enterSnapshotRow(
  row: unknown,
  entityType: SyncEntityType,
  context: string,
): JsonBox {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`${context} must be a JSON object`);
  }
  const box = row as JsonBox;
  const spec = SNAPSHOT_ROW_SPECS[entityType];
  const idField = box.id;
  if (typeof idField !== 'string' || !isSyncEntityId(idField)) {
    throw new TypeError(`${context}.id must be a 15-character lowercase alphanumeric id`);
  }
  const allowed = new Set(allowedRowFields(spec));
  for (const key of Object.keys(box)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${context}[${idField}] carries the unknown field "${key}"`);
    }
  }
  for (const [field, check] of Object.entries(spec.required)) {
    const value = box[field];
    if (value === undefined || value === null) {
      throw new TypeError(`${context}[${idField}] is missing the required field "${field}"`);
    }
    check(value, `${context}[${idField}].${field}`);
  }
  for (const [field, check] of Object.entries(spec.optional)) {
    const value = box[field];
    if (value === undefined) continue;
    if (value === null) {
      if (field in spec.nullable) continue;
      throw new TypeError(`${context}[${idField}].${field} must not be null`);
    }
    check(value, `${context}[${idField}].${field}`);
  }
  for (const [field, check] of Object.entries(spec.nullable)) {
    const value = box[field];
    if (value === undefined || value === null) continue;
    check(value, `${context}[${idField}].${field}`);
  }
  if (entityType === 'recurrence') {
    assertRecurrenceCadenceRow(box, idField, context);
  }
  return box;
}

/**
 * Cross-field cadence rule for a stored recurrence row. `frequency` absent or
 * blank means monthly, which may carry the blank `weekday: 0`. A weekly row
 * must name exactly one ISO weekday 1..7; anything else is rejected.
 */
function assertRecurrenceCadenceRow(row: JsonBox, id: string, context: string): void {
  if (row.frequency !== 'weekly') return;
  const weekday = row.weekday;
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw new TypeError(
      `${context}[${id}].weekday must be an integer within 1..7 for a weekly recurrence`,
    );
  }
}

/**
 * Validates the complete seven-collection snapshot exactly as received.
 * Returns the typed snapshot, row counts keyed by singular entity type and
 * the id sets the import ingestor uses for its collision checks.
 */
export function validateSnapshotRows(snapshot: unknown): ValidatedSnapshot {
  try {
    return validateSnapshotStructure(snapshot);
  } catch (error) {
    if (error instanceof SyncProtocolRequestError) throw error;
    if (error instanceof TypeError) {
      throw new SyncProtocolRequestError('PAGE_INVALID', error.message);
    }
    throw error;
  }
}

function validateSnapshotStructure(snapshot: unknown): ValidatedSnapshot {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      'A snapshot must be a JSON object of the seven financial collections.',
    );
  }
  const box = snapshot as JsonBox;
  for (const key of Object.keys(box)) {
    if (!(COLLECTION_KEYS as readonly string[]).includes(key)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `A snapshot carries the unknown collection "${key}".`,
      );
    }
  }
  for (const collection of COLLECTION_KEYS) {
    if (!Array.isArray(box[collection])) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `Snapshot "${collection}" must be an array.`,
      );
    }
  }

  const counts = {} as Record<SyncEntityType, number>;
  const idsByEntityType = {} as Record<SyncEntityType, Set<string>>;
  const rowsByEntityType = {} as Record<SyncEntityType, readonly JsonBox[]>;

  for (const entityType of SYNC_ENTITY_TYPES) {
    idsByEntityType[entityType] = new Set<string>();
  }

  let totalRows = 0;
  for (const entityType of SYNC_ENTITY_TYPES) {
    const collection = SYNC_COLLECTIONS[entityType];
    const rows = box[collection] as unknown[];
    const validated: JsonBox[] = [];
    const seenIds = idsByEntityType[entityType];
    for (const row of rows) {
      const typed = enterSnapshotRow(
        row,
        entityType,
        `snapshot.${collection}`,
      );
      const id = typed.id as string;
      if (seenIds.has(id)) {
        throw new SyncProtocolRequestError(
          'PAGE_INVALID',
          `snapshot.${collection} contains the duplicate row id "${id}".`,
        );
      }
      seenIds.add(id);
      validated.push(typed);
    }
    rowsByEntityType[entityType] = validated;
    counts[entityType] = validated.length;
    totalRows += validated.length;
  }

  if (totalRows > SYNC_IMPORT_MAX_ROWS || totalRows > SYNC_SEED_MAX_ROWS) {
    throw new SyncProtocolRequestError(
      'REQUEST_TOO_LARGE',
      `The snapshot carries ${totalRows} rows; the bound is ${SYNC_SEED_MAX_ROWS}.`,
      413,
    );
  }

  // References may point at rows declared later, so this is a second pass.
  for (const entityType of SYNC_ENTITY_TYPES) {
    const relations = SNAPSHOT_RELATION_TARGETS[entityType];
    if (relations.length === 0) continue;
    for (const [relationField, targetType] of relations) {
      for (const row of rowsByEntityType[entityType]) {
        const value = row[relationField];
        if (typeof value !== 'string' || value === '') continue;
        if (!idsByEntityType[targetType].has(value)) {
          throw new SyncProtocolRequestError(
            'PAGE_INVALID',
            `snapshot.${SYNC_COLLECTIONS[entityType]}[${String(row.id)}] references the missing ${relationField} "${value}".`,
          );
        }
      }
    }
  }

  return { snapshot: box as unknown as SyncSeedSnapshot, counts };
}

// ---------------------------------------------------------------------------
// Six-field import hash (D7)
// ---------------------------------------------------------------------------

/**
 * Recomputes the import envelope hash over exactly the six
 * `SYNC_IMPORT_HASH_FIELDS` of the raw request (never `payloadHash`), using the
 * shared canonical JSON encoder. The six values are plain JSON by the time the
 * body is parsed, so the canonical encoder receives them unchanged.
 */
export function recomputeImportPayloadHash(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'An import body must be a JSON object.');
  }
  const box = raw as JsonBox;
  try {
    const sixFieldInput: Record<string, SyncJsonValue> = {};
    for (const field of SYNC_IMPORT_HASH_FIELDS) {
      if (!(field in box)) {
        throw new SyncProtocolRequestError(
          'PAGE_INVALID',
          `An import body is missing the required field "${field}".`,
        );
      }
      sixFieldInput[field] = toSyncJsonValue(box[field], `import field "${field}"`);
    }
    return canonicalHash(sixFieldInput);
  } catch (error) {
    if (error instanceof SyncProtocolRequestError) throw error;
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      `The import envelope is not representable as canonical JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Frame validators
// ---------------------------------------------------------------------------

const SEED_FIELDS: readonly string[] = [
  'protocolVersion',
  'stationId',
  'serverInstanceId',
  'dataEpoch',
  'snapshot',
];
const IMPORT_FIELDS: readonly string[] = [...SEED_FIELDS, 'importId', 'payloadHash'];

function rejectFrameFields(box: JsonBox, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(box)) {
    if (!allowed.includes(key)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `A ${label} body carries the unknown field "${key}".`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in box)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `A ${label} body is missing the required field "${key}".`,
      );
    }
  }
}

function validateSnapshotIdentityFields(box: JsonBox): void {
  if (!Number.isInteger(box.protocolVersion) || (box.protocolVersion as number) < 1) {
    throw new SyncProtocolRequestError('PROTOCOL_UNSUPPORTED', 'protocolVersion must be a positive integer.');
  }
  if (typeof box.stationId !== 'string' || !isSyncUuid(box.stationId)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'stationId must be a lowercase hyphenated UUID.');
  }
  if (typeof box.serverInstanceId !== 'string' || !isSyncUuid(box.serverInstanceId)) {
    throw new SyncProtocolRequestError('ENDPOINT_MISMATCH', 'serverInstanceId must be a lowercase hyphenated UUID.');
  }
  if (!Number.isInteger(box.dataEpoch) || (box.dataEpoch as number) < 1) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'dataEpoch must be a positive integer.');
  }
}

export function validateSeedFrame(raw: unknown): SyncSeedRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'A seed body must be a JSON object.');
  }
  const box = raw as JsonBox;
  rejectFrameFields(box, SEED_FIELDS, 'seed');
  validateSnapshotIdentityFields(box);
  const { snapshot } = validateSnapshotRows(box.snapshot);
  return {
    protocolVersion: box.protocolVersion as number,
    stationId: box.stationId as string,
    serverInstanceId: box.serverInstanceId as string,
    dataEpoch: box.dataEpoch as number,
    snapshot,
  };
}

export function validateImportFrame(raw: unknown): SyncImportRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'An import body must be a JSON object.');
  }
  const box = raw as JsonBox;
  rejectFrameFields(box, IMPORT_FIELDS, 'import');
  validateSnapshotIdentityFields(box);
  if (typeof box.importId !== 'string' || !isSyncUuidV7(box.importId)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'importId must be a lowercase hyphenated UUIDv7.');
  }
  if (typeof box.payloadHash !== 'string' || !isSyncSha256Hash(box.payloadHash)) {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      'payloadHash must be sha256: followed by 43 unpadded base64url characters.',
    );
  }

  // Hash the six RAW fields before any structural normalization below.
  const recomputed = recomputeImportPayloadHash(raw);
  if (recomputed !== box.payloadHash) {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      'The declared import payloadHash does not match the six-field snapshot envelope.',
    );
  }

  const { snapshot } = validateSnapshotRows(box.snapshot);
  return {
    protocolVersion: box.protocolVersion as number,
    stationId: box.stationId as string,
    serverInstanceId: box.serverInstanceId as string,
    dataEpoch: box.dataEpoch as number,
    importId: box.importId as string,
    snapshot,
    payloadHash: box.payloadHash as SyncSha256Hash,
  };
}
