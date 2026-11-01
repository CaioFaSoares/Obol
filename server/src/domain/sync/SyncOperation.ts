// Immutable operation envelopes, exhaustive operation payloads and per
// operation outcomes for server-authoritative synchronization (D016 D2/D3/D4,
// canon §12.2). Framework-free: only domain entity types are imported.
//
// Every operation type maps one-to-one to an existing use case and reuses the
// existing HTTP DTO field names. No operation patches arbitrary fields, and no
// operation describes invoice or balance side effects: those are computed by
// the server use cases, never sent by a client.
//
// Canonical hashing rules (`payloadHash`, `chainHash`, `prevHash`, `headHash`,
// `cursorHash`, `ownerFingerprint`, record hashes):
// - `sha256:` + unpadded base64url(SHA-256(bytes)); the empty genesis hash is
//   the empty string.
// - Canonical JSON sorts object keys recursively at every depth, emits UTF-8,
//   has no insignificant whitespace, uses standard JSON scalar encoding and
//   encodes negative zero as `0`, decimals with their shortest round-trip form,
//   and unicode without lossy escaping of printable characters.
// - `payloadHash` keeps its name for wire compatibility but hashes the complete
//   immutable envelope: protocolVersion, stationId, opId, type, entityType,
//   entityId, payload, baseRevisions, dependsOn, clientCreatedAt, effectiveAt.
//   The transmitted `payloadHash` field itself is never part of that
//   eleven-field hashed input. An absent optional `dependsOn` is encoded as
//   `[]`, never omitted.
// - A queued operation may acquire dependency-derived base revisions and
//   persist its final envelope/hash before the first send. After the first send
//   the envelope is immutable; a corrected or rebased intent is a new opId.

import type { Account } from '../entities/Account';
import type { Card } from '../entities/Card';
import type { Category } from '../entities/Category';
import type { Project } from '../entities/Project';
import type { RecurrenceUpdatePatch } from '../entities/Recurrence';
import type { TransactionUpdatePatch } from '../entities/Transaction';
import type {
  SyncBaseRevisions,
  SyncEntityId,
  SyncEntityType,
  SyncEntityVersionRef,
  SyncRecord,
  SyncRevision,
  SyncSha256Hash,
} from './SyncRevision';

// ---------------------------------------------------------------------------
// Payloads (existing DTO field names, inward-only domain shapes)
// ---------------------------------------------------------------------------

/** `AccountDTO`: name, type, initial_balance. The record id is `entityId`. */
export type SyncAccountCreatePayload = Readonly<
  Omit<Account, 'id' | 'created' | 'updated'>
>;

/** `CardDTO`. */
export type SyncCardCreatePayload = Readonly<
  Omit<Card, 'id' | 'created' | 'updated'>
>;

/** Partial `CardDTO`; omitted fields keep their current server value. */
export type SyncCardUpdatePayload = Partial<SyncCardCreatePayload>;

/** `CategoryDTO`. */
export type SyncCategoryCreatePayload = Readonly<
  Omit<Category, 'id' | 'created' | 'updated'>
>;

/** `ProjectCreateDTO`; the server assigns `status: 'active'`. */
export type SyncProjectCreatePayload = Readonly<
  Pick<Project, 'name' | 'total_value'>
>;

/** `ProjectPaymentDTO`. */
export interface SyncProjectPaymentPayload {
  readonly amount: number;
  readonly description?: string;
}

/** `RecurrenceDTO`; the server assigns `status: 'active'` on create. */
export interface SyncRecurrenceCreatePayload {
  readonly name: string;
  readonly amount: number;
  readonly payday: number;
  readonly type: 'income' | 'expense';
  /** Cadence; absent means monthly. Weekly requires an ISO `weekday`. */
  readonly frequency?: 'monthly' | 'weekly';
  readonly weekday?: number;
  readonly account_id?: string;
  readonly card_id?: string;
  readonly category_id?: string;
  readonly end_date?: string;
  readonly total_installments?: number;
  readonly skipped_periods?: readonly string[];
}

/**
 * `recurrence.update` payload. An omitted field keeps its stored value and
 * `null` clears a canonical optional relation or date. Create stays null-free:
 * a client omits unset fields instead of sending null.
 */
export type SyncRecurrenceUpdatePayload = RecurrenceUpdatePatch;

export interface SyncRecurrenceToggleStatusPayload {
  readonly status: 'active' | 'paused';
}

/**
 * `TransactionDTO` extended with the already canonical optional
 * `recurrence_id`, which the older public DTO omitted. `invoice_id` is never
 * sent: the server recomputes invoice routing. Every `transaction.create` with
 * `card_id` uses `expected_date` as the purchase-date input, exactly like the
 * public DTO, and the server derives the invoice from it. A scheduler-generated
 * occurrence reconstructs `expected_date` from its recorded `purchase_date`,
 * never from a local invoice due date. `purchase_date` is an optional redundant
 * date that must agree with `expected_date` when supplied.
 */
export interface SyncTransactionCreatePayload {
  readonly title: string;
  readonly amount: number;
  readonly type: 'income' | 'expense' | 'transfer';
  readonly status: 'pending' | 'realized';
  readonly expected_date: string;
  readonly realized_date?: string;
  readonly is_recurring?: boolean;
  readonly is_silent?: boolean;
  readonly is_simulated?: boolean;
  readonly is_scheduled?: boolean;
  readonly purchase_date?: string;
  readonly account_id?: string;
  readonly card_id?: string;
  readonly category_id?: string;
  readonly project_id?: string;
  readonly destination_account_id?: string;
  /** Create-only scheduler extension; never sent by `transaction.update`. */
  readonly recurrence_id?: string;
}

/**
 * `transaction.update` payload. An omitted field keeps its stored value and
 * `null` clears a canonical optional relation or date. `recurrence_id` stays
 * create-only: it links a scheduler-generated occurrence to its recurrence and
 * is never patched by a later update. `invoice_id` is never sent either; the
 * server recomputes invoice routing.
 */
export type SyncTransactionUpdatePayload = TransactionUpdatePatch;

export interface SyncTransactionRealizePayload {
  readonly update_balance: boolean;
}

/** `PayInvoiceDTO`. */
export interface SyncInvoicePayPayload {
  readonly period: string;
  readonly account_id?: string;
  readonly amount_paid?: number;
  readonly ignore_balance?: boolean;
}

export interface SyncInvoiceDeletePayload {
  readonly card_id: string;
  readonly period: string;
}

/** Operations whose use case takes no payload fields. */
export type SyncEmptyPayload = { readonly [key: string]: never };

// ---------------------------------------------------------------------------
// Exhaustive operation table
// ---------------------------------------------------------------------------

/** Operation type -> payload shape. This interface is the complete D016 table. */
export interface SyncOperationPayloads {
  'account.create': SyncAccountCreatePayload;
  'card.create': SyncCardCreatePayload;
  'card.update': SyncCardUpdatePayload;
  'category.create': SyncCategoryCreatePayload;
  'project.create': SyncProjectCreatePayload;
  'project.payment': SyncProjectPaymentPayload;
  'project.complete': SyncEmptyPayload;
  'recurrence.create': SyncRecurrenceCreatePayload;
  'recurrence.update': SyncRecurrenceUpdatePayload;
  'recurrence.delete': SyncEmptyPayload;
  'recurrence.toggleStatus': SyncRecurrenceToggleStatusPayload;
  'recurrence.launch': SyncEmptyPayload;
  'transaction.create': SyncTransactionCreatePayload;
  'transaction.update': SyncTransactionUpdatePayload;
  'transaction.realize': SyncTransactionRealizePayload;
  'transaction.delete': SyncEmptyPayload;
  'invoice.pay': SyncInvoicePayPayload;
  'invoice.delete': SyncInvoiceDeletePayload;
}

export type SyncOperationType = keyof SyncOperationPayloads;

export type SyncOperationPayload<K extends SyncOperationType> =
  SyncOperationPayloads[K];

/**
 * Runtime enumeration of every contract operation. Validators and operation
 * mappers use this instead of re-listing the table.
 */
export const SYNC_OPERATION_TYPES = [
  'account.create',
  'card.create',
  'card.update',
  'category.create',
  'project.create',
  'project.payment',
  'project.complete',
  'recurrence.create',
  'recurrence.update',
  'recurrence.delete',
  'recurrence.toggleStatus',
  'recurrence.launch',
  'transaction.create',
  'transaction.update',
  'transaction.realize',
  'transaction.delete',
  'invoice.pay',
  'invoice.delete',
] as const satisfies readonly SyncOperationType[];

/**
 * Operation type -> written entity type. For `project.payment` the entity is
 * the project; for `invoice.pay` it is the invoice.
 */
export const SYNC_OPERATION_ENTITY_TYPES = {
  'account.create': 'account',
  'card.create': 'card',
  'card.update': 'card',
  'category.create': 'category',
  'project.create': 'project',
  'project.payment': 'project',
  'project.complete': 'project',
  'recurrence.create': 'recurrence',
  'recurrence.update': 'recurrence',
  'recurrence.delete': 'recurrence',
  'recurrence.toggleStatus': 'recurrence',
  'recurrence.launch': 'recurrence',
  'transaction.create': 'transaction',
  'transaction.update': 'transaction',
  'transaction.realize': 'transaction',
  'transaction.delete': 'transaction',
  'invoice.pay': 'invoice',
  'invoice.delete': 'invoice',
} as const satisfies Readonly<Record<SyncOperationType, SyncEntityType>>;

export type SyncOperationEntityType<K extends SyncOperationType> =
  (typeof SYNC_OPERATION_ENTITY_TYPES)[K];

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface SyncOperationEnvelopeBase {
  /** Integer protocol version; sync requests are rejected outside the range. */
  readonly protocolVersion: number;
  /** Durable installation id registered by handshake, never derived from a token. */
  readonly stationId: string;
  /** Client-generated UUIDv7, immutable for the life of the operation. */
  readonly opId: string;
  /** Target entity id; for creates it is the client-chosen record id. */
  readonly entityId: SyncEntityId;
  readonly baseRevisions: SyncBaseRevisions;
  /**
   * Operations that must be accepted first. Always present on the wire; an
   * absent value in the client store is persisted and hashed as `[]`.
   */
  readonly dependsOn: readonly string[];
  /** Audit data only. It never orders operations or resolves a conflict. */
  readonly clientCreatedAt: string;
  /**
   * ISO UTC business event time captured when the user performed the financial
   * action. Supplied to the use case through the operation clock; replay at
   * reconnect never substitutes the receipt time.
   */
  readonly effectiveAt: string;
}

export type SyncOperationEnvelope<K extends SyncOperationType> =
  SyncOperationEnvelopeBase & {
    readonly type: K;
    readonly entityType: SyncOperationEntityType<K>;
    readonly payload: SyncOperationPayloads[K];
  };

/** Proper discriminated union of every operation envelope. */
export type SyncOperation = {
  [K in SyncOperationType]: SyncOperationEnvelope<K>;
}[SyncOperationType];

export interface SyncOperationHash {
  /** Complete-envelope hash (see header); never the payload alone. */
  readonly payloadHash: SyncSha256Hash;
}

export type SyncOperationWireOf<K extends SyncOperationType> =
  SyncOperationEnvelope<K> & SyncOperationHash;

/** Operation as sent by push and stored in `obol_sync_operations`. */
export type SyncOperationWire = {
  [K in SyncOperationType]: SyncOperationWireOf<K>;
}[SyncOperationType];

/** Envelope fields covered by `payloadHash`, in canonical hash order. */
export const SYNC_ENVELOPE_HASH_FIELDS = [
  'protocolVersion',
  'stationId',
  'opId',
  'type',
  'entityType',
  'entityId',
  'payload',
  'baseRevisions',
  'dependsOn',
  'clientCreatedAt',
  'effectiveAt',
] as const satisfies readonly (keyof SyncOperationEnvelope<SyncOperationType>)[];

/** Exact input of the complete-envelope hash, exposed for interop fixtures. */
export type SyncEnvelopeHashInput = SyncOperation;

export type SyncOperationStatus =
  | 'applied'
  | 'duplicate'
  | 'conflict'
  | 'rejected'
  | 'blocked';

export const SYNC_OPERATION_STATUSES = [
  'applied',
  'duplicate',
  'conflict',
  'rejected',
  'blocked',
] as const satisfies readonly SyncOperationStatus[];

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export interface SyncAppliedEntity extends SyncEntityVersionRef {
  /**
   * Complete authoritative server record after the write, or `null` for a
   * deleted entity. An accepted result lists every entity the operation
   * touched, including deleted tombstones, not only surviving records, so a
   * delete can atomically remove the accepted base row and its outbox intent.
   */
  readonly record: SyncRecord | null;
}

export interface SyncAppliedOperationResult {
  readonly opId: string;
  readonly status: 'applied';
  /** Every touched entity's new revision, including deleted tombstones. */
  readonly entityVersions: readonly SyncEntityVersionRef[];
  /** Every touched entity, including deleted tombstones with `record: null`. */
  readonly entities: readonly SyncAppliedEntity[];
}

/** Same-opId, same-envelope retry returns the stored original result. */
export type SyncDuplicateOperationResult = Omit<
  SyncAppliedOperationResult,
  'status'
> & {
  readonly status: 'duplicate';
};

/** One stale or covered-write conflict. */
export interface SyncConflictEntry {
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  /**
   * Revision the client declared. `null` only for a client-local preemptive
   * conflict on a create whose id appeared in a pull event; a server
   * `SYNC_CONFLICT` always carries the declared integer revision.
   */
  readonly baseRevision: SyncRevision | null;
  readonly currentRevision: SyncRevision;
  /** Authoritative server record, or `null` for a delete tombstone. */
  readonly current: SyncRecord | null;
}

export interface SyncConflictOperationResult {
  readonly opId: string;
  readonly status: 'conflict';
  readonly code: 'SYNC_CONFLICT';
  readonly conflicts: readonly SyncConflictEntry[];
}

/** Every stable per-operation rejection reason, in contract order. */
export const SYNC_OPERATION_REJECTION_CODES = [
  'OP_ID_REUSED',
  'ENVELOPE_HASH_MISMATCH',
  'UNKNOWN_OPERATION_TYPE',
  'INVALID_PAYLOAD',
  'COMMIT_TOO_LARGE',
  'UNCOVERED_WRITE',
  'MISSING_ENTITY',
  'ENTITY_ID_TAKEN',
  'RECURRENCE_MONTH_EXISTS',
] as const;

/** Stable per-operation rejection reasons. A rejected opId is final. */
export type SyncOperationRejectionCode =
  (typeof SYNC_OPERATION_REJECTION_CODES)[number];

export function isSyncOperationRejectionCode(
  value: string,
): value is SyncOperationRejectionCode {
  return (SYNC_OPERATION_REJECTION_CODES as readonly string[]).includes(value);
}

export interface SyncRejectedOperationResult {
  readonly opId: string;
  readonly status: 'rejected';
  readonly code: SyncOperationRejectionCode;
  readonly message: string;
}

/**
 * A dependency was not accepted in this batch and is not already accepted.
 * Nothing was written and the operation was not recorded; the client keeps it
 * queued and retries after the dependency is accepted.
 */
export interface SyncBlockedOperationResult {
  readonly opId: string;
  readonly status: 'blocked';
  readonly code: 'DEPENDENCY_NOT_ACCEPTED';
  readonly message: string;
  readonly blockedBy: readonly string[];
}

export type SyncOperationResult =
  | SyncAppliedOperationResult
  | SyncDuplicateOperationResult
  | SyncConflictOperationResult
  | SyncRejectedOperationResult
  | SyncBlockedOperationResult;

// ---------------------------------------------------------------------------
// Durable client outbox and conflicts
// ---------------------------------------------------------------------------

export type SyncOutboxStatus =
  | 'queued'
  | 'in_flight'
  | 'accepted'
  | 'conflict'
  | 'rejected';

/** Pre-operation snapshot of every entity the pending operation changes. */
export interface SyncEntitySnapshot {
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  /** Observed server revision, or `null` when the entity did not exist. */
  readonly revision: SyncRevision | null;
  readonly record: SyncRecord | null;
}

export interface SyncOutboxState {
  readonly status: SyncOutboxStatus;
  readonly beforeSnapshots: readonly SyncEntitySnapshot[];
  readonly attempts: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Frozen queued intent (`obol_station_outbox` / iOS `sync_outbox`). The
 * complete envelope and its hash are persisted before the first send; a
 * rebase or correction creates a new operation with a new opId.
 */
export type SyncOutboxOperation = {
  [K in SyncOperationType]: SyncOperationWireOf<K> & SyncOutboxState;
}[SyncOperationType];

export type SyncConflictResolution = 'pending' | 'server' | 'retry' | 'discarded';

/** Durable local conflict record (`obol_station_conflicts`). */
export interface SyncConflictRecord {
  readonly opId: string;
  readonly conflicts: readonly SyncConflictEntry[];
  readonly resolution: SyncConflictResolution;
  readonly createdAt: string;
  readonly updatedAt: string;
}
