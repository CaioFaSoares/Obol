// Raw sync wire validators (E007 SYNC-06/SYNC-07). Pure TypeScript, no Elysia
// schema objects: every sync route reads the bounded raw body itself, so the
// complete-envelope hash is computed over exactly the JSON values the client
// sent, BEFORE any coercion, default injection or unknown-field cleaning.
//
// Unknown fields are rejected, never stripped. JSON numbers stay numbers
// ("5.2" is rejected, never coerced) and date strings keep their raw bytes in
// the hashed envelope. Frame-level failures (malformed frame shape, request
// bound) raise `SyncProtocolRequestError`; a per-operation failure returns a
// typed rejection so the executor reports it per op without writing anything.
//
// Canonical hash discipline (D016 D2 rule 9, canon §12.2): the same shared
// canonical JSON encoder implements the eleven-field complete-envelope hash
// here and in `MutationCoordinator.resolveIdempotency`, so a tampered or
// re-encoded envelope can never reach a receipt read.

import {
  SYNC_OPERATION_ENTITY_TYPES,
  SYNC_OPERATION_TYPES,
  SYNC_ENVELOPE_HASH_FIELDS,
  type SyncOperationType,
  type SyncOperationWire,
} from '../../domain/sync/SyncOperation';
import {
  isSyncEntityId,
  isSyncEntityType,
  type SyncHash,
} from '../../domain/sync/SyncRevision';
import { SYNC_GENESIS_CURSOR } from '../../domain/sync/SyncChange';
import {
  SYNC_OPERATION_MAX_BYTES,
  SYNC_PULL_LIMIT_MAX,
  SYNC_PULL_LIMIT_MIN,
  SYNC_PUSH_MAX_OPERATIONS,
  SyncProtocolRequestError,
  isSyncUuid,
  isSyncUuidV7,
  type SyncHandshakeRequest,
  type SyncPullQuery,
  type SyncStationPlatform,
} from '../../domain/sync/SyncProtocol';
import {
  canonicalJsonLength,
  isSyncSha256Hash,
  normalizeSyncTimestamp,
  operationEnvelopeHash,
  toSyncJsonValue,
  type SyncEnvelopeHashable,
} from '../sync/CanonicalJson';

type JsonBox = { [key: string]: unknown };

const ACCOUNT_TYPES: readonly string[] = ['checking', 'savings', 'investment'];
const CATEGORY_TYPES: readonly string[] = ['fixed_budget', 'variable'];
const FINANCE_TYPES: readonly string[] = ['income', 'expense'];
const TRANSACTION_TYPES: readonly string[] = [...FINANCE_TYPES, 'transfer'];
const TRANSACTION_STATUSES: readonly string[] = ['pending', 'realized'];
const RECURRENCE_FREQUENCIES: readonly string[] = ['monthly', 'weekly'];
const TOGGLE_STATUSES: readonly string[] = ['active', 'paused'];
const STATION_PLATFORMS: readonly string[] = ['ios', 'macos', 'windows'];

const HANDSHAKE_FIELDS: readonly string[] = [
  'protocolVersion',
  'stationId',
  'platform',
  'deviceLabel',
  'clientCursor',
  'clientCursorHash',
  'dataEpoch',
  'serverInstanceId',
];
const PUSH_FRAME_FIELDS: readonly string[] = [
  'protocolVersion',
  'stationId',
  'serverInstanceId',
  'dataEpoch',
  'ops',
];
const ENVELOPE_FIELDS: readonly string[] = [
  ...SYNC_ENVELOPE_HASH_FIELDS,
  'payloadHash',
];

function unexpectedKeysOf(
  present: readonly string[],
  allowed: readonly string[],
): readonly string[] {
  const allowedKeys = new Set(allowed);
  return present.filter((key) => !allowedKeys.has(key));
}

function missingKeysOf(
  present: readonly string[],
  required: readonly string[],
): readonly string[] {
  return required.filter((key) => !present.includes(key));
}

function enterObject(
  payload: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  context: string,
): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError(`${context} must be a JSON object`);
  }
  const box = payload as JsonBox;
  const keys = Object.keys(box);
  for (const key of unexpectedKeysOf(keys, [...requiredKeys, ...optionalKeys])) {
    throw new TypeError(`${context} carries the unknown field "${key}"`);
  }
  for (const key of missingKeysOf(keys, requiredKeys)) {
    throw new TypeError(`${context} is missing the required field "${key}"`);
  }
  return box;
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

function nonNegativeAmount(value: unknown, context: string): void {
  finiteNumber(value, context);
  if ((value as number) < 0) {
    throw new TypeError(`${context} must be zero or greater`);
  }
}

function integerWithin(
  value: unknown,
  min: number,
  max: number,
  context: string,
): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new TypeError(`${context} must be an integer within ${min}..${max}`);
  }
}

function literalOf(
  value: unknown,
  allowed: readonly string[],
  context: string,
): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`${context} must be one of ${allowed.join(' | ')}`);
  }
}

function booleanStrict(value: unknown, context: string): void {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${context} must be a boolean`);
  }
}

/**
 * One business date/time string. Accepts the RFC3339 public form and the
 * PocketBase stored form (space separator), exactly like the server's
 * canonical timestamp reader. A calendar date without a time part is rejected
 * where the public DTO requires a date-time.
 */
function businessTimestamp(value: unknown, context: string): void {
  if (typeof value !== 'string') {
    throw new TypeError(`${context} must be an ISO-8601 timestamp string`);
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

/** Calendar date alone (`YYYY-MM-DD`) or a full timestamp. */
function dateOrTimestamp(value: unknown, context: string): void {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
      throw new TypeError(`${context} is not a valid calendar date`);
    }
    return;
  }
  businessTimestamp(value, context);
}

function relationLike(value: unknown, context: string): void {
  if (typeof value !== 'string') {
    throw new TypeError(`${context} must be a relation id string`);
  }
  if (value !== '' && !isSyncEntityId(value)) {
    throw new TypeError(
      `${context} must be a 15-character lowercase id or the empty string`,
    );
  }
}

/**
 * Period identity: `YYYY-MM` for invoice and monthly recurrence periods, and
 * `YYYY-MM-DD` for weekly recurrence skip keys.
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

function periodArray(value: unknown, context: string): void {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${context} must be an array of YYYY-MM periods or YYYY-MM-DD day keys`,
    );
  }
  value.forEach((entry, index) =>
    periodString(entry, `${context}[${String(index)}]`),
  );
}

/** UTC day identity of a purchase date, normalized over the two wire forms. */
function purchaseDayOf(value: string): string {
  return value.slice(0, 10).replace(' ', 'T');
}

/** Patch field that must be a real value when present; `null` never valid. */
function strictPatchField(
  box: Record<string, unknown>,
  key: string,
  validate: (value: unknown, context: string) => void,
  context: string,
): void {
  const value = box[key];
  if (value === undefined) return;
  validate(value, `${context}.${key}`);
}

/**
 * Patch field that may be explicitly cleared: `undefined` omits, `null`
 * clears a canonical optional relation/date, any other value is validated.
 */
function clearableField(
  box: Record<string, unknown>,
  key: string,
  validate: (value: unknown, context: string) => void,
  context: string,
): void {
  const value = box[key];
  if (value === undefined || value === null) return;
  validate(value, `${context}.${key}`);
}

// ---------------------------------------------------------------------------
// Per-operation payload table
// ---------------------------------------------------------------------------

type PayloadValidator = (payload: unknown, context: string) => void;

const SYNC_PAYLOAD_VALIDATORS: Record<SyncOperationType, PayloadValidator> = {
  'account.create': (payload, context) => {
    const box = enterObject(
      payload,
      ['name', 'type', 'initial_balance'],
      [],
      `${context}.payload`,
    );
    nonEmptyString(box.name, `${context}.payload.name`);
    literalOf(box.type, ACCOUNT_TYPES, `${context}.payload.type`);
    finiteNumber(box.initial_balance, `${context}.payload.initial_balance`);
  },

  'card.create': (payload, context) => {
    const box = enterObject(
      payload,
      ['name', 'closing_day', 'due_day', 'limit'],
      [],
      `${context}.payload`,
    );
    nonEmptyString(box.name, `${context}.payload.name`);
    integerWithin(box.closing_day, 1, 31, `${context}.payload.closing_day`);
    integerWithin(box.due_day, 1, 31, `${context}.payload.due_day`);
    nonNegativeAmount(box.limit, `${context}.payload.limit`);
  },

  'card.update': (payload, context) => {
    const box = enterObject(
      payload,
      [],
      ['name', 'closing_day', 'due_day', 'limit'],
      `${context}.payload`,
    );
    strictPatchField(box, 'name', nonEmptyString, `${context}.payload`);
    strictPatchField(
      box,
      'closing_day',
      (value, fieldContext) => integerWithin(value, 1, 31, fieldContext),
      `${context}.payload`,
    );
    strictPatchField(
      box,
      'due_day',
      (value, fieldContext) => integerWithin(value, 1, 31, fieldContext),
      `${context}.payload`,
    );
    strictPatchField(
      box,
      'limit',
      nonNegativeAmount,
      `${context}.payload`,
    );
  },

  'category.create': (payload, context) => {
    const box = enterObject(
      payload,
      ['name', 'type'],
      ['monthly_budget'],
      `${context}.payload`,
    );
    nonEmptyString(box.name, `${context}.payload.name`);
    literalOf(box.type, CATEGORY_TYPES, `${context}.payload.type`);
    strictPatchField(
      box,
      'monthly_budget',
      nonNegativeAmount,
      `${context}.payload`,
    );
  },

  'project.create': (payload, context) => {
    const box = enterObject(
      payload,
      ['name', 'total_value'],
      [],
      `${context}.payload`,
    );
    nonEmptyString(box.name, `${context}.payload.name`);
    nonNegativeAmount(box.total_value, `${context}.payload.total_value`);
  },

  'project.payment': (payload, context) => {
    const box = enterObject(
      payload,
      ['amount'],
      ['description'],
      `${context}.payload`,
    );
    positiveAmount(box.amount, `${context}.payload.amount`);
    strictPatchField(
      box,
      'description',
      nonEmptyString,
      `${context}.payload`,
    );
  },

  'project.complete': (payload, context) => {
    enterObject(payload, [], [], `${context}.payload`);
  },

  'recurrence.create': (payload, context) => {
    const box = enterObject(
      payload,
      ['name', 'amount', 'payday', 'type'],
      [
        'frequency',
        'weekday',
        'account_id',
        'card_id',
        'category_id',
        'end_date',
        'total_installments',
        'skipped_periods',
      ],
      `${context}.payload`,
    );
    nonEmptyString(box.name, `${context}.payload.name`);
    positiveAmount(box.amount, `${context}.payload.amount`);
    integerWithin(box.payday, 1, 31, `${context}.payload.payday`);
    literalOf(box.type, FINANCE_TYPES, `${context}.payload.type`);
    if (box.frequency !== undefined) {
      literalOf(box.frequency, RECURRENCE_FREQUENCIES, `${context}.payload.frequency`);
    }
    if (box.weekday !== undefined) {
      integerWithin(box.weekday, 1, 7, `${context}.payload.weekday`);
    }
    // A create is a complete row, so the cadence rule is decidable here.
    if (box.frequency === 'weekly' && box.weekday === undefined) {
      throw new TypeError(
        `${context}.payload.weekday is required for a weekly recurrence`,
      );
    }
    for (const relation of ['account_id', 'card_id', 'category_id'] as const) {
      if (box[relation] !== undefined) {
        relationLike(box[relation], `${context}.payload.${relation}`);
      }
    }
    if (box.end_date !== undefined) {
      dateOrTimestamp(box.end_date, `${context}.payload.end_date`);
    }
    if (box.total_installments !== undefined) {
      integerWithin(
        box.total_installments,
        1,
        Number.MAX_SAFE_INTEGER,
        `${context}.payload.total_installments`,
      );
    }
    if (box.skipped_periods !== undefined) {
      periodArray(box.skipped_periods, `${context}.payload.skipped_periods`);
    }
  },

  'recurrence.update': (payload, context) => {
    const box = enterObject(
      payload,
      [],
      [
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
      `${context}.payload`,
    );
    strictPatchField(box, 'name', nonEmptyString, `${context}.payload`);
    strictPatchField(box, 'amount', positiveAmount, `${context}.payload`);
    strictPatchField(
      box,
      'payday',
      (value, fieldContext) => integerWithin(value, 1, 31, fieldContext),
      `${context}.payload`,
    );
    strictPatchField(
      box,
      'type',
      (value, fieldContext) => literalOf(value, FINANCE_TYPES, fieldContext),
      `${context}.payload`,
    );
    // A patch can switch the cadence, so a weekly patch without a weekday is
    // only decidable against stored state; the use case validates the final row.
    clearableField(
      box,
      'frequency',
      (value, fieldContext) => literalOf(value, RECURRENCE_FREQUENCIES, fieldContext),
      `${context}.payload`,
    );
    clearableField(
      box,
      'weekday',
      (value, fieldContext) => integerWithin(value, 1, 7, fieldContext),
      `${context}.payload`,
    );
    clearableField(box, 'account_id', relationLike, `${context}.payload`);
    clearableField(box, 'card_id', relationLike, `${context}.payload`);
    clearableField(box, 'category_id', relationLike, `${context}.payload`);
    clearableField(box, 'end_date', dateOrTimestamp, `${context}.payload`);
    clearableField(
      box,
      'total_installments',
      (value, fieldContext) =>
        integerWithin(value, 1, Number.MAX_SAFE_INTEGER, fieldContext),
      `${context}.payload`,
    );
    strictPatchField(
      box,
      'skipped_periods',
      periodArray,
      `${context}.payload`,
    );
  },

  'recurrence.delete': (payload, context) => {
    enterObject(payload, [], [], `${context}.payload`);
  },

  'recurrence.toggleStatus': (payload, context) => {
    const box = enterObject(payload, ['status'], [], `${context}.payload`);
    literalOf(box.status, TOGGLE_STATUSES, `${context}.payload.status`);
  },

  'recurrence.launch': (payload, context) => {
    enterObject(payload, [], [], `${context}.payload`);
  },

  'transaction.create': (payload, context) => {
    const box = enterObject(
      payload,
      ['title', 'amount', 'type', 'status', 'expected_date'],
      [
        'realized_date',
        'is_recurring',
        'is_silent',
        'is_simulated',
        'is_scheduled',
        'purchase_date',
        'account_id',
        'card_id',
        'category_id',
        'project_id',
        'destination_account_id',
        'recurrence_id',
      ],
      `${context}.payload`,
    );
    nonEmptyString(box.title, `${context}.payload.title`);
    positiveAmount(box.amount, `${context}.payload.amount`);
    literalOf(box.type, TRANSACTION_TYPES, `${context}.payload.type`);
    literalOf(box.status, TRANSACTION_STATUSES, `${context}.payload.status`);
    businessTimestamp(box.expected_date, `${context}.payload.expected_date`);
    if (box.realized_date !== undefined) {
      businessTimestamp(box.realized_date, `${context}.payload.realized_date`);
    }
    for (const flag of [
      'is_recurring',
      'is_silent',
      'is_simulated',
      'is_scheduled',
    ] as const) {
      if (box[flag] !== undefined) {
        booleanStrict(box[flag], `${context}.payload.${flag}`);
      }
    }
    if (box.purchase_date !== undefined) {
      businessTimestamp(box.purchase_date, `${context}.payload.purchase_date`);
    }
    for (const relationField of [
      'account_id',
      'card_id',
      'category_id',
      'project_id',
      'destination_account_id',
      'recurrence_id',
    ] as const) {
      if (box[relationField] !== undefined) {
        relationLike(box[relationField], `${context}.payload.${relationField}`);
      }
    }

    // Create-only scheduler extension (canon §12.3): a linked generated fact
    // requires the canonical `is_recurring: true`; the linked recurrence and
    // its occurrence state are validated inside the operation executor where
    // the store view exists. `invoice_id` is never sent: invoice routing is
    // computed by the server. A card purchase routes from `expected_date`; a
    // redundant `purchase_date` must agree on the UTC day.
    if (box.recurrence_id !== undefined && box.is_recurring !== true) {
      throw new TypeError(
        `${context}.payload must set is_recurring: true when it carries recurrence_id`,
      );
    }
    if (
      typeof box.card_id === 'string' &&
      box.card_id !== '' &&
      typeof box.purchase_date === 'string' &&
      typeof box.expected_date === 'string' &&
      purchaseDayOf(box.purchase_date) !== purchaseDayOf(box.expected_date)
    ) {
      throw new TypeError(
        `${context}.payload.purchase_date must agree with expected_date on the UTC day`,
      );
    }
  },

  'transaction.update': (payload, context) => {
    const box = enterObject(
      payload,
      [],
      [
        'title',
        'amount',
        'type',
        'status',
        'expected_date',
        'realized_date',
        'is_recurring',
        'is_silent',
        'is_simulated',
        'is_scheduled',
        'purchase_date',
        'account_id',
        'card_id',
        'category_id',
        'project_id',
        'destination_account_id',
      ],
      `${context}.payload`,
    );
    strictPatchField(box, 'title', nonEmptyString, `${context}.payload`);
    strictPatchField(box, 'amount', positiveAmount, `${context}.payload`);
    strictPatchField(
      box,
      'type',
      (value, fieldContext) =>
        literalOf(value, TRANSACTION_TYPES, fieldContext),
      `${context}.payload`,
    );
    strictPatchField(
      box,
      'status',
      (value, fieldContext) =>
        literalOf(value, TRANSACTION_STATUSES, fieldContext),
      `${context}.payload`,
    );
    strictPatchField(
      box,
      'expected_date',
      businessTimestamp,
      `${context}.payload`,
    );
    clearableField(box, 'realized_date', businessTimestamp, `${context}.payload`);
    for (const flag of [
      'is_recurring',
      'is_silent',
      'is_simulated',
      'is_scheduled',
    ] as const) {
      if (box[flag] !== undefined) {
        booleanStrict(box[flag], `${context}.payload.${flag}`);
      }
    }
    clearableField(box, 'purchase_date', businessTimestamp, `${context}.payload`);
    for (const relationField of [
      'account_id',
      'card_id',
      'category_id',
      'project_id',
      'destination_account_id',
    ] as const) {
      clearableField(box, relationField, relationLike, `${context}.payload`);
    }
  },

  'transaction.realize': (payload, context) => {
    const box = enterObject(
      payload,
      ['update_balance'],
      [],
      `${context}.payload`,
    );
    booleanStrict(box.update_balance, `${context}.payload.update_balance`);
  },

  'transaction.delete': (payload, context) => {
    enterObject(payload, [], [], `${context}.payload`);
  },

  'invoice.pay': (payload, context) => {
    const box = enterObject(
      payload,
      ['period'],
      ['account_id', 'amount_paid', 'ignore_balance'],
      `${context}.payload`,
    );
    periodString(box.period, `${context}.payload.period`);
    if (box.account_id !== undefined) {
      relationLike(box.account_id, `${context}.payload.account_id`);
    }
    if (box.amount_paid !== undefined) {
      positiveAmount(box.amount_paid, `${context}.payload.amount_paid`);
    }
    if (box.ignore_balance !== undefined) {
      booleanStrict(box.ignore_balance, `${context}.payload.ignore_balance`);
    }
  },

  'invoice.delete': (payload, context) => {
    const box = enterObject(
      payload,
      ['card_id', 'period'],
      [],
      `${context}.payload`,
    );
    if (typeof box.card_id !== 'string' || !isSyncEntityId(box.card_id)) {
      throw new TypeError(
        `${context}.payload.card_id must be a 15-character id`,
      );
    }
    periodString(box.period, `${context}.payload.period`);
  },
};

// ---------------------------------------------------------------------------
// Operation envelope validation
// ---------------------------------------------------------------------------

export interface SyncOperationValidationFailure {
  readonly code: 'ENVELOPE_HASH_MISMATCH' | 'UNKNOWN_OPERATION_TYPE' | 'INVALID_PAYLOAD';
  readonly message: string;
}

export type SyncOperationValidation =
  | { readonly ok: true; readonly op: SyncOperationWire }
  | (SyncOperationValidationFailure & {
      readonly ok: false;
      readonly opId: string | null;
    });

function invalid(
  opId: string | null,
  code: SyncOperationValidationFailure['code'],
  message: string,
): SyncOperationValidation {
  return { ok: false, opId, code, message };
}

function validationError(
  opId: string | null,
  code: SyncOperationValidationFailure['code'],
  error: unknown,
): SyncOperationValidation {
  return invalid(
    opId,
    code,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Validates one raw operation exactly as it arrived: first the per-operation
 * size bound and the eleven-field complete-envelope hash over the RAW values
 * (never a coerced or cleaned object), then the structural contract. Returns
 * the typed envelope the coordinator later accepts verbatim.
 */
export function validateOperationWire(raw: unknown): SyncOperationValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid(null, 'INVALID_PAYLOAD', 'An operation must be a JSON object');
  }
  const box = raw as JsonBox;
  const opIdRaw = box.opId;
  const opId =
    typeof opIdRaw === 'string' && isSyncUuidV7(opIdRaw) ? opIdRaw : null;

  try {
    const serialized = canonicalJsonLength(toSyncJsonValue(raw, 'operation'));
    if (serialized > SYNC_OPERATION_MAX_BYTES) {
      return invalid(
        opId,
        'INVALID_PAYLOAD',
        `The serialized operation is ${serialized} bytes; the bound is ${SYNC_OPERATION_MAX_BYTES}.`,
      );
    }
  } catch (error) {
    return validationError(opId, 'INVALID_PAYLOAD', error);
  }

  // 1. Complete-envelope hash over the raw values. The transmitted
  //    payloadHash is never part of the hashed input.
  if (!isSyncSha256Hash(box.payloadHash)) {
    return invalid(
      opId,
      'ENVELOPE_HASH_MISMATCH',
      'payloadHash must be sha256: followed by 43 unpadded base64url characters',
    );
  }
  let envelopeHash: string;
  try {
    // The eleven hashed fields read straight from the raw JSON node, so the
    // digest covers exactly the bytes the client sent. A field absent from the
    // body is a payload failure, reported before any receipt read.
    const hashInput: SyncEnvelopeHashable = {
      protocolVersion: box.protocolVersion,
      stationId: box.stationId,
      opId: box.opId,
      type: box.type,
      entityType: box.entityType,
      entityId: box.entityId,
      payload: box.payload,
      baseRevisions: box.baseRevisions,
      dependsOn: box.dependsOn,
      clientCreatedAt: box.clientCreatedAt,
      effectiveAt: box.effectiveAt,
    };
    for (const field of SYNC_ENVELOPE_HASH_FIELDS) {
      if (hashInput[field] === undefined) {
        return invalid(
          opId,
          'INVALID_PAYLOAD',
          `An operation is missing the required field "${field}"`,
        );
      }
    }
    envelopeHash = operationEnvelopeHash(hashInput);
  } catch (error) {
    return validationError(opId, 'ENVELOPE_HASH_MISMATCH', error);
  }
  if (envelopeHash !== box.payloadHash) {
    return invalid(
      opId,
      'ENVELOPE_HASH_MISMATCH',
      'The declared payloadHash does not match the received envelope values.',
    );
  }

  // 2. Exact envelope field set: the eleven hashed fields plus payloadHash.
  const present = Object.keys(box);
  for (const key of unexpectedKeysOf(present, ENVELOPE_FIELDS)) {
    return invalid(opId, 'INVALID_PAYLOAD', `An operation carries the unknown field "${key}"`);
  }
  for (const key of missingKeysOf(present, ENVELOPE_FIELDS)) {
    return invalid(opId, 'INVALID_PAYLOAD', `An operation is missing the required field "${key}"`);
  }

  // 3. Scalar envelope fields.
  if (!isSyncUuidV7(typeof box.opId === 'string' ? box.opId : '')) {
    return invalid(opId, 'INVALID_PAYLOAD', 'opId must be a lowercase hyphenated UUIDv7');
  }
  if (typeof box.stationId !== 'string' || !isSyncUuid(box.stationId)) {
    return invalid(opId, 'INVALID_PAYLOAD', 'stationId must be a lowercase hyphenated UUID');
  }
  if (!Number.isInteger(box.protocolVersion)) {
    return invalid(opId, 'INVALID_PAYLOAD', 'protocolVersion must be a positive integer');
  }
  for (const timestampField of ['clientCreatedAt', 'effectiveAt'] as const) {
    if (typeof box[timestampField] !== 'string') {
      return invalid(opId, 'INVALID_PAYLOAD', `${timestampField} must be an ISO-8601 timestamp string`);
    }
    try {
      businessTimestamp(box[timestampField], timestampField);
    } catch (error) {
      return validationError(opId, 'INVALID_PAYLOAD', error);
    }
  }

  // 4. Operation type and declared target entity.
  const rawType = box.type;
  if (
    typeof rawType !== 'string' ||
    !(SYNC_OPERATION_TYPES as readonly string[]).includes(rawType)
  ) {
    return invalid(
      opId,
      'UNKNOWN_OPERATION_TYPE',
      `Unknown operation type ${JSON.stringify(rawType)}`,
    );
  }
  const operationType = rawType as SyncOperationType;
  if (box.entityType !== SYNC_OPERATION_ENTITY_TYPES[operationType]) {
    return invalid(
      opId,
      'INVALID_PAYLOAD',
      `Operation ${operationType} must declare entityType "${SYNC_OPERATION_ENTITY_TYPES[operationType]}"`,
    );
  }
  if (typeof box.entityId !== 'string' || !isSyncEntityId(box.entityId)) {
    return invalid(
      opId,
      'INVALID_PAYLOAD',
      'entityId must be a 15-character lowercase alphanumeric id',
    );
  }

  // 5. dependsOn and baseRevisions shapes.
  if (!Array.isArray(box.dependsOn)) {
    return invalid(opId, 'INVALID_PAYLOAD', 'dependsOn must be an array of op UUIDs');
  }
  for (const [index, entry] of box.dependsOn.entries()) {
    if (typeof entry !== 'string' || !isSyncUuidV7(entry)) {
      return invalid(
        opId,
        'INVALID_PAYLOAD',
        `dependsOn[${String(index)}] must be a UUIDv7 op id`,
      );
    }
  }
  if (
    typeof box.baseRevisions !== 'object' ||
    box.baseRevisions === null ||
    Array.isArray(box.baseRevisions)
  ) {
    return invalid(opId, 'INVALID_PAYLOAD', 'baseRevisions must be an object of declared revisions');
  }
  for (const [key, revision] of Object.entries(box.baseRevisions as JsonBox)) {
    const separator = key.indexOf(':');
    const entityTypeKey = separator > 0 ? key.slice(0, separator) : '';
    const entityIdKey = separator > 0 ? key.slice(separator + 1) : '';
    if (!isSyncEntityType(entityTypeKey) || !isSyncEntityId(entityIdKey)) {
      return invalid(
        opId,
        'INVALID_PAYLOAD',
        `baseRevisions key "${key}" must be \`entityType:entityId\` with canonical shapes`,
      );
    }
    if (
      typeof revision !== 'number' ||
      !Number.isInteger(revision) ||
      revision < 1
    ) {
      return invalid(
        opId,
        'INVALID_PAYLOAD',
        `baseRevisions["${key}"] must be a positive integer revision`,
      );
    }
  }

  // 6. Payload per operation type.
  try {
    SYNC_PAYLOAD_VALIDATORS[operationType](box.payload, 'operation');
  } catch (error) {
    return validationError(opId, 'INVALID_PAYLOAD', error);
  }

  // The validator is the proof that the raw values satisfy the wire type; the
  // coordinator re-verifies the canonical hash against this exact object.
  return {
    ok: true,
    op: {
      protocolVersion: box.protocolVersion as number,
      stationId: box.stationId as string,
      opId: box.opId as string,
      type: operationType,
      entityType: SYNC_OPERATION_ENTITY_TYPES[operationType],
      entityId: box.entityId as string,
      payload: box.payload,
      baseRevisions: box.baseRevisions as Record<string, number>,
      dependsOn: box.dependsOn as string[],
      clientCreatedAt: box.clientCreatedAt as string,
      effectiveAt: box.effectiveAt as string,
      payloadHash: box.payloadHash as string,
    } as unknown as SyncOperationWire,
  };
}

// ---------------------------------------------------------------------------
// Frame validators
// ---------------------------------------------------------------------------

export interface SyncPushRequestFrame {
  readonly protocolVersion: number;
  readonly stationId: string;
  readonly serverInstanceId: string;
  readonly dataEpoch: number;
  readonly ops: readonly unknown[];
}

/**
 * Frame-level push validation. A per-operation failure is reported per op by
 * the executor; the frame itself fails the whole request only when it cannot
 * be framed at all.
 */
export function validatePushFrame(raw: unknown): SyncPushRequestFrame {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'A push body must be a JSON object.');
  }
  const box = raw as JsonBox;
  const present = Object.keys(box);
  for (const key of unexpectedKeysOf(present, PUSH_FRAME_FIELDS)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', `A push body carries the unknown field "${key}".`);
  }
  for (const key of missingKeysOf(present, PUSH_FRAME_FIELDS)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', `A push body is missing the required field "${key}".`);
  }
  if (!Array.isArray(box.ops)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'A push body must carry an ops array.');
  }
  if (box.ops.length > SYNC_PUSH_MAX_OPERATIONS) {
    throw new SyncProtocolRequestError(
      'REQUEST_TOO_LARGE',
      `A push batch carries ${box.ops.length} operations; the bound is ${SYNC_PUSH_MAX_OPERATIONS}.`,
      413,
    );
  }
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
  return {
    protocolVersion: box.protocolVersion as number,
    stationId: box.stationId as string,
    serverInstanceId: box.serverInstanceId as string,
    dataEpoch: box.dataEpoch as number,
    ops: box.ops,
  };
}

export function validateHandshakeFrame(raw: unknown): SyncHandshakeRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'A handshake body must be a JSON object.');
  }
  const box = raw as JsonBox;
  const present = Object.keys(box);
  for (const key of unexpectedKeysOf(present, HANDSHAKE_FIELDS)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', `A handshake body carries the unknown field "${key}".`);
  }
  for (const key of missingKeysOf(present, [
    'protocolVersion',
    'stationId',
    'platform',
    'deviceLabel',
  ])) {
    throw new SyncProtocolRequestError('PAGE_INVALID', `A handshake body is missing the required field "${key}".`);
  }
  if (!Number.isInteger(box.protocolVersion)) {
    throw new SyncProtocolRequestError('PROTOCOL_UNSUPPORTED', 'protocolVersion must be a positive integer.');
  }
  if (typeof box.stationId !== 'string' || !isSyncUuid(box.stationId)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'stationId must be a lowercase hyphenated UUID.');
  }
  if (typeof box.deviceLabel !== 'string') {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'deviceLabel must be a string.');
  }
  if (typeof box.platform !== 'string' || !STATION_PLATFORMS.includes(box.platform)) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'platform must be one of ios | macos | windows.');
  }

  const optionalUuid = (
    value: unknown,
    code: 'ENDPOINT_MISMATCH' | 'PAGE_INVALID',
    message: string,
  ): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !isSyncUuid(value)) {
      throw new SyncProtocolRequestError(code, message);
    }
    return value;
  };

  const serverInstanceId = optionalUuid(
    box.serverInstanceId,
    'ENDPOINT_MISMATCH',
    'A resumed serverInstanceId must be a lowercase hyphenated UUID.',
  );

  const dataEpoch =
    box.dataEpoch === undefined || box.dataEpoch === null
      ? null
      : Number.isInteger(box.dataEpoch) && (box.dataEpoch as number) >= 1
        ? (box.dataEpoch as number)
        : (() => {
            throw new SyncProtocolRequestError(
              'PAGE_INVALID',
              'A resumed dataEpoch must be a positive integer.',
            );
          })();

  const clientCursor =
    box.clientCursor === undefined || box.clientCursor === null
      ? null
      : Number.isInteger(box.clientCursor) &&
          (box.clientCursor as number) >= SYNC_GENESIS_CURSOR
        ? (box.clientCursor as number)
        : (() => {
            throw new SyncProtocolRequestError(
              'PAGE_INVALID',
              'clientCursor must be a non-negative integer or omitted.',
            );
          })();

  const clientCursorHash: SyncHash | null =
    box.clientCursorHash === undefined || box.clientCursorHash === null
      ? null
      : typeof box.clientCursorHash === 'string' &&
          (box.clientCursorHash === '' ||
            isSyncSha256Hash(box.clientCursorHash))
        ? (box.clientCursorHash as SyncHash)
        : (() => {
            throw new SyncProtocolRequestError(
              'PAGE_INVALID',
              'clientCursorHash must be a sha256 hash or the empty genesis hash at cursor 0.',
            );
          })();

  if ((clientCursor === null) !== (clientCursorHash === null)) {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      'A resuming handshake must carry both clientCursor and clientCursorHash, or neither.',
    );
  }
  if (clientCursor === 0 && clientCursorHash !== '') {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      'The cursor hash at cursor 0 is the empty genesis hash.',
    );
  }
  if (
    clientCursor !== null &&
    clientCursor !== 0 &&
    clientCursorHash === ''
  ) {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      'A non-genesis cursor needs a sha256 cursor hash.',
    );
  }

  return {
    protocolVersion: box.protocolVersion as number,
    stationId: box.stationId as string,
    platform: box.platform as SyncStationPlatform,
    deviceLabel: box.deviceLabel as string,
    clientCursor,
    clientCursorHash,
    dataEpoch,
    serverInstanceId,
  };
}

/** Pull query validation; journal-out-of-range cursors stay the reader's rollback. */
export function validatePullQuery(
  entries: ReadonlyArray<readonly [string, string]>,
): SyncPullQuery {
  const queryEntries = new Map<string, string>();
  for (const [key, value] of entries) {
    if (queryEntries.has(key)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `Pull query repeats "${key}".`,
      );
    }
    queryEntries.set(key, value);
  }
  for (const key of unexpectedKeysOf([...queryEntries.keys()], ['cursor', 'limit'])) {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      `Pull accepts only cursor and limit, not "${key}".`,
    );
  }
  const cursorRaw = queryEntries.get('cursor');
  const limitRaw = queryEntries.get('limit');
  if (cursorRaw === undefined || limitRaw === undefined) {
    throw new SyncProtocolRequestError('PAGE_INVALID', 'Pull requires cursor and limit.');
  }
  const cursor = Number(cursorRaw);
  const limit = Number(limitRaw);
  if (!Number.isInteger(cursor) || cursor < SYNC_GENESIS_CURSOR) {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      `Pull cursor must be a non-negative integer, got ${JSON.stringify(cursorRaw)}.`,
    );
  }
  if (
    !Number.isInteger(limit) ||
    limit < SYNC_PULL_LIMIT_MIN ||
    limit > SYNC_PULL_LIMIT_MAX
  ) {
    throw new SyncProtocolRequestError(
      'PAGE_INVALID',
      `Pull limit must be an integer within ${SYNC_PULL_LIMIT_MIN}..${SYNC_PULL_LIMIT_MAX}, got ${JSON.stringify(limitRaw)}.`,
    );
  }
  return { cursor, limit };
}
