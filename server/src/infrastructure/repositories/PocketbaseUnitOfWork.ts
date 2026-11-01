// Scoped record view plus the single-batch commit surface for one financial
// mutation (D016 D10, canon §12.2).
//
// This file re-implements no business behavior. Existing
// `Pocketbase*Repository` instances keep their exact method bodies and query
// surface, but they run against a buffered view instead of the raw PocketBase
// client. The unit of work owns exactly five things:
//
// 1. Buffered record access with read-your-writes for `getOne`,
//    `getFirstListItem`, `getList` and `getFullList`. Every create/update/
//    delete stays local until the one batch commit: no early remote write, no
//    compensating write and no partial commit ever happens.
// 2. A lazy per-collection buffer with a remote read cache. Collections that
//    the mutation did not touch take the exact PocketBase request untouched;
//    only a collection with buffered writes performs the bounded two-stage
//    merge (remote rows, then buffered overlay, filter, sort, projection).
// 3. Loud failures for every query shape the evaluator cannot reproduce.
//    Unknown filter syntax, sort segments or projections throw
//    `UnsupportedQueryError`; they never silently return all rows or drop the
//    caller's constraint.
// 4. Stable client ids: a create without a valid 15-character lowercase id
//    receives a CSPRNG one. Provided ids are preserved, and an id that exists
//    remotely is refused instead of being reused.
// 5. A coalesced finance plan (one real record write per touched entity) with
//    the complete expected record precomputed for change events, results and
//    pre-write snapshots, followed by one `pb.createBatch()` carrying the
//    finance entries plus the metadata entries the coordinator appends via
//    `metadataBatch()`. Capacity is enforced before that request leaves the
//    process.
//
// The in-process mutation gate, revision assignment, conflict checks and the
// journal live in `MutationCoordinator`; this class only produces the plan.

import type PocketBase from 'pocketbase';
import { ClientResponseError } from 'pocketbase';

import type { PaginatedResult } from '../../domain/interfaces/Common';
import {
  SYNC_COLLECTIONS,
  type SyncCollectionName,
  type SyncEntityType,
} from '../../domain/sync/SyncRevision';
import { canonicalJsonLength, toSyncJsonValue } from '../sync/CanonicalJson';
import { isValidEntityId, newSyncEntityId } from '../sync/RecordIds';

/**
 * One PocketBase record as returned by the SDK. The SDK's dynamic surface is
 * `any`; this named alias keeps every remote-row cast in one place.
 */
type PocketRecordRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Finance collection name -> owning sync entity type (canon §12.4). */
const ENTITY_TYPE_BY_COLLECTION: Readonly<Record<string, SyncEntityType>> =
  Object.fromEntries(
    (Object.keys(SYNC_COLLECTIONS) as SyncEntityType[]).map((entityType) => [
      SYNC_COLLECTIONS[entityType],
      entityType,
    ]),
  ) as Readonly<Record<string, SyncEntityType>>;

/** Deterministic entity-type order used by every finance plan. */
const ENTITY_TYPES_IN_ORDER = Object.keys(SYNC_COLLECTIONS) as SyncEntityType[];

/** Collections the metadata appender is allowed to target. */
const METADATA_COLLECTION_PREFIXES = ['obol_sync_', 'obol_station_'] as const;

/**
 * PocketBase batch body bound, pinned and proved in an isolated PB 0.40.6
 * volume (`maxBodySize: 50331648` bytes = 48 MiB).
 */
const PB_BATCH_MAX_BODY_BYTES = 50_331_648;
/** PocketBase batch request bound (`maxRequests: 60000`). */
const PB_BATCH_MAX_REQUESTS = 60_000;
/** Multipart framing margin so the canonical measure stays conservative. */
const PB_BATCH_FRAMING_BYTES = 4_096;

/** PocketBase list endpoint page cap; any other value fails loudly here. */
const PB_MAX_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A repository query the buffered evaluator cannot reproduce exactly. */
export class UnsupportedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedQueryError';
  }
}

/** A hard pre-write bound exceeded; the coordinator maps it to wire codes. */
export class MutationCapacityExceededError extends Error {
  readonly bound: 'COMMIT_EVENTS' | 'COMMIT_BYTES' | 'BATCH_BYTES' | 'BATCH_REQUESTS';
  readonly limit: number;

  constructor(
    bound: MutationCapacityExceededError['bound'],
    limit: number,
  ) {
    super(
      bound === 'COMMIT_EVENTS'
        ? `Commit would exceed ${limit} entity events`
        : bound === 'COMMIT_BYTES'
          ? `Commit group serialization exceeds ${limit} bytes`
          : bound === 'BATCH_REQUESTS'
            ? `Batch would exceed ${limit} requests`
            : `Batch body exceeds ${limit} bytes`,
    );
    this.name = 'MutationCapacityExceededError';
    this.bound = bound;
    this.limit = limit;
  }
}

type BufferedWriteConflictReason = 'ENTITY_ID_TAKEN' | 'ID_REUSED_AFTER_DELETE';

/** A buffered write ordering the accepted contract forbids. */
export class BufferedWriteConflictError extends Error {
  readonly reason: BufferedWriteConflictReason;

  constructor(reason: BufferedWriteConflictReason, message: string) {
    super(message);
    this.name = 'BufferedWriteConflictError';
    this.reason = reason;
  }
}

/** A structural sync precondition failed before any write left the process. */
export class MutationPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutationPreconditionError';
  }
}

// ---------------------------------------------------------------------------
// PocketBase filter subset: tokenizer, recursive parser and row evaluation
// ---------------------------------------------------------------------------

type FilterOperator = '=' | '!=' | '~' | '>' | '>=' | '<' | '<=';
type FilterLiteral = string | number | boolean | null;

interface FilterClause {
  readonly kind: 'clause';
  readonly field: string;
  readonly op: FilterOperator;
  readonly value: FilterLiteral;
}

interface FilterGroup {
  readonly kind: 'group';
  readonly op: 'AND' | 'OR';
  readonly children: readonly FilterNode[];
}

type FilterNode = FilterClause | FilterGroup;

type FilterToken =
  | { readonly type: 'identifier'; readonly text: string }
  | { readonly type: 'operator'; readonly text: FilterOperator }
  | { readonly type: 'literal'; readonly value: FilterLiteral }
  | { readonly type: 'and' }
  | { readonly type: 'or' }
  | { readonly type: 'lparen' }
  | { readonly type: 'rparen' };

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Numeric literal grammar the evaluator reproduces: optional sign, decimal
 * digits, optional fraction and optional exponent. A token that is neither a
 * finite number nor an identifier fails loudly instead of being coerced.
 */
const FILTER_NUMBER_LITERAL_PATTERN =
  /^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** Parses one numeric filter literal, or `null` when the token is not one. */
export function parseFilterNumberLiteral(text: string): number | null {
  if (!FILTER_NUMBER_LITERAL_PATTERN.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Pushes the pending identifier/literal/number token scanned so far. */
function pushBareToken(
  tokens: FilterToken[],
  text: string,
  filter: string,
): void {
  if (text === 'null' || text === 'true' || text === 'false') {
    tokens.push({
      type: 'literal',
      value: text === 'null' ? null : text === 'true',
    });
    return;
  }
  const numeric = parseFilterNumberLiteral(text);
  if (numeric !== null) {
    tokens.push({ type: 'literal', value: numeric });
    return;
  }
  if (!IDENTIFIER_PATTERN.test(text)) {
    throw new UnsupportedQueryError(
      `Filter token "${text}" is unsupported by the buffered query evaluator (filter: "${filter}")`,
    );
  }
  tokens.push({ type: 'identifier', text });
}

function tokenizeFilter(filter: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  let index = 0;
  let tokenStart = 0;

  const flush = (end: number): void => {
    if (end > tokenStart) {
      pushBareToken(tokens, filter.slice(tokenStart, end), filter);
    }
  };

  while (index < filter.length) {
    const char = filter[index]!;

    if (/\s/.test(char)) {
      flush(index);
      index += 1;
      tokenStart = index;
      continue;
    }

    if (char === '(' || char === ')') {
      flush(index);
      tokens.push({ type: char === '(' ? 'lparen' : 'rparen' });
      index += 1;
      tokenStart = index;
      continue;
    }

    if (char === "'") {
      flush(index);
      index += 1;
      let value = '';
      let terminated = false;
      while (index < filter.length) {
        const literalChar = filter[index]!;
        if (literalChar === '\\' && filter[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        if (literalChar === '\\' && filter[index + 1] === '\\') {
          value += '\\';
          index += 2;
          continue;
        }
        if (literalChar === "'") {
          terminated = true;
          index += 1;
          break;
        }
        value += literalChar;
        index += 1;
      }
      if (!terminated) {
        throw new UnsupportedQueryError(
          `Unterminated quoted literal in filter (filter: "${filter}")`,
        );
      }
      tokens.push({ type: 'literal', value });
      tokenStart = index;
      continue;
    }

    if (filter.startsWith('&&', index)) {
      flush(index);
      tokens.push({ type: 'and' });
      index += 2;
      tokenStart = index;
      continue;
    }

    if (filter.startsWith('||', index)) {
      flush(index);
      tokens.push({ type: 'or' });
      index += 2;
      tokenStart = index;
      continue;
    }

    const twoChar = filter.slice(index, index + 2);
    if (twoChar === '>=' || twoChar === '<=' || twoChar === '!=') {
      flush(index);
      tokens.push({ type: 'operator', text: twoChar });
      index += 2;
      tokenStart = index;
      continue;
    }

    if (char === '=' || char === '>' || char === '<' || char === '~') {
      flush(index);
      tokens.push({ type: 'operator', text: char });
      index += 1;
      tokenStart = index;
      continue;
    }

    index += 1;
  }

  flush(index);

  if (tokens.length === 0) {
    throw new UnsupportedQueryError('Empty filter expression');
  }
  return tokens;
}

class FilterParser {
  private cursor = 0;

  constructor(
    private readonly tokens: readonly FilterToken[],
    private readonly source: string,
  ) {}

  parse(): FilterNode {
    const node = this.parseOr();
    if (this.cursor !== this.tokens.length) {
      throw new UnsupportedQueryError(
        `Trailing filter tokens after a complete expression (filter: "${this.source}")`,
      );
    }
    return node;
  }

  private tokenAt(offset: number): FilterToken | undefined {
    return this.tokens[this.cursor + offset];
  }

  private parseOr(): FilterNode {
    const children: FilterNode[] = [this.parseAnd()];
    while (this.tokenAt(0)?.type === 'or') {
      this.cursor += 1;
      children.push(this.parseAnd());
    }
    return children.length === 1
      ? children[0]!
      : { kind: 'group', op: 'OR', children };
  }

  private parseAnd(): FilterNode {
    const children: FilterNode[] = [this.parsePrimary()];
    while (this.tokenAt(0)?.type === 'and') {
      this.cursor += 1;
      children.push(this.parsePrimary());
    }
    return children.length === 1
      ? children[0]!
      : { kind: 'group', op: 'AND', children };
  }

  private parsePrimary(): FilterNode {
    const token = this.tokenAt(0);

    if (token?.type === 'lparen') {
      this.cursor += 1;
      const inner = this.parseOr();
      if (this.tokenAt(0)?.type !== 'rparen') {
        throw new UnsupportedQueryError(
          `Unbalanced parentheses in filter (filter: "${this.source}")`,
        );
      }
      this.cursor += 1;
      return inner;
    }

    if (token?.type !== 'identifier') {
      throw new UnsupportedQueryError(
        `Filter clause must start with a field identifier (filter: "${this.source}")`,
      );
    }
    if (token.text.startsWith('@')) {
      throw new UnsupportedQueryError(
        `Filter field "${token.text}" is unsupported by the buffered query evaluator (filter: "${this.source}")`,
      );
    }

    const operator = this.tokenAt(1);
    if (operator?.type !== 'operator') {
      throw new UnsupportedQueryError(
        `Filter clause for "${token.text}" is missing a comparison operator (filter: "${this.source}")`,
      );
    }
    const literal = this.tokenAt(2);
    if (literal?.type !== 'literal') {
      throw new UnsupportedQueryError(
        `Filter comparison for "${token.text}" needs a quoted string, number, boolean or null literal (filter: "${this.source}")`,
      );
    }

    this.cursor += 3;
    return {
      kind: 'clause',
      field: token.text,
      op: operator.text,
      value: literal.value,
    };
  }
}

function parseFilter(filter: string): FilterNode {
  return new FilterParser(tokenizeFilter(filter), filter).parse();
}

/** SQL-like field resolution: an absent key reads exactly like NULL. */
function recordValueOf(record: PocketRecordRow, field: string): unknown {
  const value = record[field];
  return value === undefined ? null : value;
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Type order for mixed record values (number < string < boolean). Within one
 * type the comparison is numeric or UTF-16 code-unit order, which equals
 * SQLite BINARY collation for the ASCII identifiers and ISO dates this
 * domain sorts on. NULL sorts lowest, mirroring SQLite.
 */
function valueRank(value: unknown): number {
  if (typeof value === 'number') return 0;
  if (typeof value === 'string') return 1;
  if (typeof value === 'boolean') return 2;
  throw new UnsupportedQueryError(
    `Sortable record value of type ${typeof value} is unsupported`,
  );
}

function compareSortableValues(left: unknown, right: unknown): number {
  const leftNull = isNullish(left);
  const rightNull = isNullish(right);
  if (leftNull && rightNull) return 0;
  if (leftNull) return -1;
  if (rightNull) return 1;

  const leftRank = valueRank(left);
  const rightRank = valueRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;

  if (leftRank === 0) {
    const leftNumber = left as number;
    const rightNumber = right as number;
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  const leftText = left as string | boolean;
  const rightText = right as string | boolean;
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function compareEquality(value: unknown, literal: unknown): boolean {
  if (typeof literal === 'boolean') {
    if (typeof value === 'boolean') return value === literal;
    // Defensive: a stored 0/1 stays comparable with a boolean literal.
    return value === (literal ? 1 : 0);
  }
  if (typeof literal === 'number') {
    return typeof value === 'number' && value === literal;
  }
  return typeof value === 'string' && value === literal;
}

function evaluateClause(
  record: PocketRecordRow,
  clause: FilterClause,
): boolean {
  const value = recordValueOf(record, clause.field);
  const literal = clause.value;

  switch (clause.op) {
    case '=':
      if (literal === null) return isNullish(value);
      return compareEquality(value, literal);
    case '!=':
      if (literal === null) return !isNullish(value);
      // SQL: a comparison against NULL is unknown, so it never matches.
      if (isNullish(value)) return false;
      return !compareEquality(value, literal);
    case '~': {
      // PocketBase `~` is a case-insensitive substring match for ASCII.
      if (literal === null || isNullish(value)) return false;
      return String(value)
        .toLowerCase()
        .includes(String(literal).toLowerCase());
    }
    case '>':
    case '>=':
    case '<':
    case '<=': {
      if (literal === null || isNullish(value)) return false;
      const order = compareSortableValues(value, literal);
      if (clause.op === '>') return order > 0;
      if (clause.op === '>=') return order >= 0;
      if (clause.op === '<') return order < 0;
      return order <= 0;
    }
  }
}

function evaluateFilter(record: PocketRecordRow, node: FilterNode): boolean {
  if (node.kind === 'clause') {
    return evaluateClause(record, node);
  }
  if (node.op === 'AND') {
    return node.children.every((child) => evaluateFilter(record, child));
  }
  return node.children.some((child) => evaluateFilter(record, child));
}

// ---------------------------------------------------------------------------
// Sort and projection parsing
// ---------------------------------------------------------------------------

interface SortSegment {
  readonly field: string;
  readonly direction: 1 | -1;
}

const SORT_SEGMENT_PATTERN = /^[+-]?[A-Za-z0-9_]+$/;

function parseSort(sort: string | undefined): readonly SortSegment[] {
  if (typeof sort !== 'string' || sort.trim() === '') {
    return [];
  }
  return sort.split(',').map<SortSegment>((segment) => {
    const name = segment.trim();
    if (!SORT_SEGMENT_PATTERN.test(name)) {
      throw new UnsupportedQueryError(
        `Sort segment "${segment}" is unsupported by the buffered query evaluator (sort: "${sort}")`,
      );
    }
    return {
      field: name.replace(/^[+-]/, ''),
      direction: name.startsWith('-') ? -1 : 1,
    };
  });
}

function compareRecordsWithSort(
  left: PocketRecordRow,
  right: PocketRecordRow,
  sort: readonly SortSegment[],
): number {
  for (const segment of sort) {
    const order = compareSortableValues(
      recordValueOf(left, segment.field),
      recordValueOf(right, segment.field),
    );
    if (order !== 0) {
      return order * segment.direction;
    }
  }
  // Deterministic tiebreak across merged remote and buffered rows only.
  return compareSortableValues(
    recordValueOf(left, 'id'),
    recordValueOf(right, 'id'),
  );
}

function parseFieldsProjection(fields: string | undefined): readonly string[] {
  if (fields === undefined) return [];
  if (fields.trim() === '*') return ['*'];
  const names = fields.split(',').map((name) => name.trim());
  if (names.some((name) => !IDENTIFIER_PATTERN.test(name))) {
    throw new UnsupportedQueryError(
      `Fields projection "${fields}" is unsupported by the buffered query evaluator (only plain field names or "*")`,
    );
  }
  return names;
}

function projectRecord(
  record: PocketRecordRow,
  projection: readonly string[],
): PocketRecordRow {
  if (projection.length === 0 || projection[0] === '*') {
    return record;
  }
  const projected: PocketRecordRow = {};
  for (const field of projection) {
    if (field in record) {
      projected[field] = record[field];
    }
  }
  return projected;
}

// ---------------------------------------------------------------------------
// Buffered write types
// ---------------------------------------------------------------------------

/** One buffered create/update/delete entry, keyed by PocketBase record id. */
interface BufferedEntry {
  readonly kind: 'create' | 'update' | 'delete';
  /** Set for `create`; already carries the assigned or provided id. */
  createData?: PocketRecordRow;
  /** Ordered update bodies; later patches win. Empty for create/delete. */
  readonly patches: PocketRecordRow[];
}

/** Collection-scoped buffer plus the remote read cache of one mutation. */
interface CollectionBufferState {
  readonly name: SyncCollectionName;
  readonly entityType: SyncEntityType;
  readonly buffered: Map<string, BufferedEntry>;
  /** Cached remote rows; `null` marks a fetched-and-missing (404) record. */
  readonly remoteCache: Map<string, PocketRecordRow | null>;
}

/** One coalesced finance write, already expressed as its final PB record. */
export interface BufferedRowWrite {
  readonly kind: 'create' | 'update' | 'delete';
  /** The sync entity type owning this collection (canon §12.4). */
  readonly entityType: SyncEntityType;
  readonly collectionName: SyncCollectionName;
  readonly recordId: string;
  /**
   * Complete expected server record used verbatim for change events and the
   * applied result (`null` for a delete tombstone).
   */
  readonly record: PocketRecordRow | null;
}

/** One `pb.createBatch()` request entry (finance and metadata alike). */
export interface BatchEntry {
  readonly method: 'create' | 'update' | 'delete';
  readonly collectionName: string;
  readonly recordId?: string;
  readonly body: PocketRecordRow | null;
}

/** Metadata appender handed to `PocketbaseSyncRepository` before a commit. */
export interface SyncBatchAppender {
  create(collectionName: string, body: PocketRecordRow): void;
  update(collectionName: string, recordId: string, body: PocketRecordRow): void;
}

/** Structurally the documented subset of `PocketBase` repositories may use. */
export interface PocketBaseViewLike {
  collection(name: string): BufferedPocketbaseCollection;
  filter(raw: string, params?: { [key: string]: unknown }): string;
}

/**
 * Record-access view for exactly one finance collection inside one mutation:
 * the documented subset of the PocketBase SDK method surface the current
 * `Pocketbase*Repository` implementations use.
 */
export interface BufferedPocketbaseCollection {
  getOne<T = unknown>(id: string): Promise<T>;
  getFirstListItem<T = unknown>(filter: string): Promise<T>;
  getList<T = unknown>(
    page: number,
    perPage: number,
    options?: SyncListViewOptions,
  ): Promise<PaginatedResult<T>>;
  getFullList<T = unknown>(options?: SyncListViewOptions): Promise<T[]>;
  create<T = unknown>(data: PocketRecordRow): Promise<T>;
  update<T = unknown>(id: string, data: PocketRecordRow): Promise<T>;
  delete(id: string): Promise<void>;
}

/** Subset of PocketBase record list options the repositories pass today. */
export interface SyncListViewOptions {
  sort?: string;
  filter?: string;
  fields?: string;
  expand?: string;
}

/**
 * Read-only authoritative dataset a replay fork materializes from. The
 * station replica builds it from `obol_station_versions.baseRecord` (plus the
 * journal events of the page being applied) before any pending intent is
 * replayed. Writes never reach this source; they stay in the fork's buffer.
 */
export interface ReplayBaseline {
  /** Authoritative row or `null` when the entity has no server base. */
  getRecord(collectionName: SyncCollectionName, id: string): PocketRecordRow | null;
  /** Every authoritative row of one finance collection. */
  listRecords(collectionName: SyncCollectionName): readonly PocketRecordRow[];
  /**
   * Existing durable id that a create of this exact body should reuse, or
   * `null` when the entity is genuinely new. The station replica returns the
   * original client-created ids here so a later pending intent that already
   * names the entity keeps resolving after replay.
   */
  preferredCreateId?(
    collectionName: SyncCollectionName,
    body: PocketRecordRow,
  ): string | null;
}

/** Optional replay behavior of one unit of work. */
export interface PocketbaseUnitOfWorkOptions {
  readonly replayBaseline?: ReplayBaseline;
  /** Deterministic id source for creates without an explicit id. */
  readonly mintEntityId?: () => string;
}

/**
 * One coalesced finance row plus the exact body PocketBase receives.
 */
interface PlannedFinanceRow {
  readonly write: BufferedRowWrite;
  readonly body: PocketRecordRow | null;
}

// ---------------------------------------------------------------------------
// Pure record helpers
// ---------------------------------------------------------------------------

function notFound404(id: string): ClientResponseError {
  return new ClientResponseError({
    status: 404,
    url: '',
    response: {
      code: 404,
      message: "The requested resource wasn't found.",
    },
    originalError: new Error(`Record ${id} was not found`),
  });
}

/** Field-level merge mirroring a PocketBase update body over its row. */
function mergePatchOverlay(
  base: PocketRecordRow,
  patches: readonly PocketRecordRow[],
): PocketRecordRow {
  const merged: PocketRecordRow = { ...base };
  for (const patch of patches) {
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/**
 * Exact PATCH body of one buffered update: the coalesced patch fields only.
 * The remote row's system fields (`created`, `updated`, `collectionId`, …)
 * are never re-sent; `id` is system-owned and cannot be patched.
 */
function coalescedPatchBody(
  patches: readonly PocketRecordRow[],
): PocketRecordRow {
  const body: PocketRecordRow = {};
  for (const patch of patches) {
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      if (value !== undefined) {
        body[key] = value;
      }
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Unit of work
// ---------------------------------------------------------------------------

export class PocketbaseUnitOfWork {
  private readonly states = new Map<SyncCollectionName, CollectionBufferState>();
  private readonly metadataEntries: BatchEntry[] = [];
  private readonly replayBaseline: ReplayBaseline | undefined;
  private readonly mintEntityId: (() => string) | undefined;
  private closed = false;

  constructor(
    private readonly pb: PocketBase,
    options: PocketbaseUnitOfWorkOptions = {},
  ) {
    this.replayBaseline = options.replayBaseline;
    this.mintEntityId = options.mintEntityId;
  }

  /** True for a fork that reads a fixed baseline and can never commit. */
  isReplayFork(): boolean {
    return this.replayBaseline !== undefined;
  }

  /**
   * Returns the buffered view of one finance collection. `view()` performs the
   * single documented cast that keeps existing repository constructors
   * (`pb: PocketBase`) working without any edit.
   */
  collection(name: string): BufferedPocketbaseCollection {
    this.assertOpen();
    const entityType = ENTITY_TYPE_BY_COLLECTION[name];
    if (!entityType) {
      throw new UnsupportedQueryError(
        `.collection() is restricted to the finance collections ${Object.values(
          SYNC_COLLECTIONS,
        ).join(', ')}; "${name}" is not buffered`,
      );
    }
    return new BufferedCollectionFacade(
      this.stateFor(name as SyncCollectionName),
      this,
    );
  }

  /** `pb.filter` passthrough so parameterized repository filters stay exact. */
  filter(raw: string, params?: { [key: string]: unknown }): string {
    this.assertOpen();
    return this.pb.filter(raw, params);
  }

  /**
   * The role-compatible view handed to existing repository constructors.
   * Repositories take `pb: PocketBase`; the integration boundary performs the
   * single documented cast `uow.view() as unknown as PocketBase`.
   */
  view(): PocketBaseViewLike {
    return {
      collection: (name) => this.collection(name),
      filter: (raw, params) => this.filter(raw, params),
    };
  }

  /**
   * Metadata appender for the `obol_sync_*` / `obol_station_*` collections,
   * consumed by `PocketbaseSyncRepository` immediately before
   * `executeCommit()` so finance and metadata land in one atomic batch.
   */
  metadataBatch(): SyncBatchAppender {
    return {
      create: (collectionName, body) => {
        this.appendMetadata('create', collectionName, undefined, body);
      },
      update: (collectionName, recordId, body) => {
        this.appendMetadata('update', collectionName, recordId, body);
      },
    };
  }

  /**
   * Coalesced finance-row writes in deterministic order: domain entity-type
   * order, then record id ascending. `record` is the complete expected server
   * record (remote base plus every buffered patch), which is exactly what
   * change events, applied results and the idempotency ledger store.
   */
  bufferedRowWrites(): readonly BufferedRowWrite[] {
    this.assertOpen();
    return this.planFinanceRows().map((row) => row.write);
  }

  /**
   * Sends one real PocketBase batch: finance entries first, metadata entries
   * afterwards, in append order (D10 step 6). Both hard bounds (body bytes and
   * request count) are measured before any request leaves this process. A
   * PocketBase batch is atomic, so a failure can never persist a partial
   * commit. Returns the per-entry results in entry order.
   */
  async executeCommit(): Promise<
    ReadonlyArray<{ status: number; body: unknown }>
  > {
    this.assertOpen();
    if (this.replayBaseline !== undefined) {
      throw new MutationPreconditionError(
        'A replay fork reads a fixed baseline and never commits; the station replica commits its materialized diff in one batch',
      );
    }
    const entries: BatchEntry[] = [];
    for (const row of this.planFinanceRows()) {
      const write = row.write;
      entries.push(
        write.kind === 'create'
          ? {
              method: 'create',
              collectionName: write.collectionName,
              body: row.body,
            }
          : {
              method: write.kind,
              collectionName: write.collectionName,
              recordId: write.recordId,
              body: row.body,
            },
      );
    }
    for (const metadataEntry of this.metadataEntries) {
      entries.push(metadataEntry);
    }
    if (entries.length === 0) {
      this.close();
      return [];
    }

    this.assertBatchCapacity(entries);

    const batch = this.pb.createBatch();
    for (const entry of entries) {
      const collection = batch.collection(entry.collectionName);
      if (entry.method === 'create') {
        collection.create(entry.body ?? {});
      } else if (entry.method === 'update') {
        collection.update(entry.recordId!, entry.body ?? {});
      } else {
        collection.delete(entry.recordId!);
      }
    }
    const results = await batch.send();
    this.close();
    return results;
  }

  /**
   * Clears every buffer and unsent entry without any remote effect: the safe
   * release path after a rejected operation, a conflict, or any throw inside
   * the use case. Idempotent; a committed unit of work is already closed.
   */
  discard(): void {
    this.close();
  }

  /**
   * @internal Authoritative pre-write state of one entity under the single-
   * writer gate: the untouched remote record, or `null` when it does not
   * exist. Used by the coordinator for conflict payloads and outbox
   * before-snapshots.
   */
  async preCommitRecord(
    collectionName: SyncCollectionName,
    recordId: string,
  ): Promise<Record<string, unknown> | null> {
    this.assertOpen();
    const state = this.stateFor(collectionName);
    return this.fetchRemoteRecord(state, recordId);
  }

  // -----------------------------------------------------------------------
  // Internal plumbing (consumed only by the facade below)
  // -----------------------------------------------------------------------

  /**
   * @internal Id for a create that carried no explicit id. A replay fork
   * supplies a deterministic source so the same queued intent rebuilds the
   * same records after every restart.
   */
  nextEntityId(): string {
    this.assertOpen();
    const candidate = this.mintEntityId === undefined
      ? newSyncEntityId()
      : this.mintEntityId();
    if (!isValidEntityId(candidate)) {
      throw new MutationPreconditionError(
        `The entity id source returned "${candidate}", not a 15-character lowercase id`,
      );
    }
    return candidate;
  }

  /**
   * @internal Durable id a replay should reuse for this create body, or
   * `null` when the entity has no local predecessor.
   */
  preferredCreateId(
    collectionName: SyncCollectionName,
    body: PocketRecordRow,
  ): string | null {
    this.assertOpen();
    const candidate = this.replayBaseline?.preferredCreateId?.(collectionName, body);
    if (candidate === null || candidate === undefined) return null;
    if (!isValidEntityId(candidate)) {
      throw new MutationPreconditionError(
        `The replay id source returned "${candidate}", not a 15-character lowercase id`,
      );
    }
    return candidate;
  }

  /** @internal Raw PocketBase full-list request for one finance collection. */
  async fetchRemoteRows(
    state: CollectionBufferState,
    options?: SyncListViewOptions,
  ): Promise<PocketRecordRow[]> {
    if (this.replayBaseline !== undefined) {
      return this.queryBaseline(state, options);
    }
    const rows = (await this.pb
      .collection(state.name)
      .getFullList(options)) as PocketRecordRow[];
    return rows;
  }

  /**
   * @internal Rows a merged query starts from: the complete authoritative
   * dataset for a replay fork (the evaluator applies filter/sort/projection),
   * or the server's already-filtered rows for a live unit of work.
   */
  async fetchMergeRows(
    state: CollectionBufferState,
    options?: SyncListViewOptions,
  ): Promise<PocketRecordRow[]> {
    if (this.replayBaseline !== undefined) {
      return [...this.replayBaseline.listRecords(state.name)];
    }
    return await this.fetchRemoteRows(state, options);
  }

  /** @internal Raw PocketBase paged request, preserving server pagination. */
  async fetchRemotePage(
    state: CollectionBufferState,
    page: number,
    perPage: number,
    options?: SyncListViewOptions,
  ): Promise<PaginatedResult<PocketRecordRow>> {
    if (this.replayBaseline !== undefined) {
      const rows = this.queryBaseline(state, options);
      const start = (page - 1) * perPage;
      return {
        items: rows.slice(start, start + perPage),
        page,
        perPage,
        totalItems: rows.length,
        totalPages: Math.ceil(rows.length / perPage),
      };
    }
    const result = await this.pb
      .collection(state.name)
      .getList(page, perPage, options);
    return result as unknown as PaginatedResult<PocketRecordRow>;
  }

  /** @internal Raw PocketBase first-item request. */
  async fetchRemoteFirstRow(
    state: CollectionBufferState,
    filter: string,
  ): Promise<PocketRecordRow> {
    if (this.replayBaseline !== undefined) {
      const rows = this.queryBaseline(state, { filter });
      if (rows.length === 0) throw notFound404(filter);
      return rows[0]!;
    }
    return (await this.pb
      .collection(state.name)
      .getFirstListItem(filter)) as PocketRecordRow;
  }

  /** @internal Cached point read; `null` records a 404. */
  async fetchRemoteRecord(
    state: CollectionBufferState,
    id: string,
  ): Promise<PocketRecordRow | null> {
    const cached = state.remoteCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (this.replayBaseline !== undefined) {
      const record = this.replayBaseline.getRecord(state.name, id);
      state.remoteCache.set(id, record);
      return record;
    }
    try {
      const record = (await this.pb
        .collection(state.name)
        .getOne(id)) as PocketRecordRow;
      state.remoteCache.set(id, record);
      return record;
    } catch (error) {
      if (error instanceof ClientResponseError && error.status === 404) {
        state.remoteCache.set(id, null);
        return null;
      }
      throw error;
    }
  }

  /**
   * Exact in-memory evaluation of one filter/sort/projection over the replay
   * baseline. The same evaluator the merged query uses is applied, so a
   * replay reads exactly the rows the live repositories would have read from
   * the authoritative base.
   */
  private queryBaseline(
    state: CollectionBufferState,
    options?: SyncListViewOptions,
  ): PocketRecordRow[] {
    const baseline = this.replayBaseline;
    if (baseline === undefined) {
      throw new MutationPreconditionError('No replay baseline is configured');
    }
    if (options?.expand !== undefined) {
      throw new UnsupportedQueryError(
        'A replay fork cannot reproduce an expand query; mutation use cases never request one',
      );
    }
    const filterNode = options?.filter ? parseFilter(options.filter) : null;
    const sort = parseSort(options?.sort);
    const projection = parseFieldsProjection(options?.fields);
    const rows = baseline
      .listRecords(state.name)
      .filter((row) => filterNode === null || evaluateFilter(row, filterNode));
    const ordered = [...rows];
    if (sort.length === 0) {
      ordered.sort((left, right) =>
        compareSortableValues(
          recordValueOf(left, 'id'),
          recordValueOf(right, 'id'),
        ),
      );
    } else {
      ordered.sort((left, right) => compareRecordsWithSort(left, right, sort));
    }
    if (projection.length === 0 || projection[0] === '*') {
      return ordered;
    }
    return ordered.map((row) => projectRecord(row, projection));
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new MutationPreconditionError(
        'This unit of work already completed or was discarded',
      );
    }
  }

  private stateFor(name: SyncCollectionName): CollectionBufferState {
    const existing = this.states.get(name);
    if (existing) {
      return existing;
    }
    const entityType = ENTITY_TYPE_BY_COLLECTION[name];
    if (!entityType) {
      throw new UnsupportedQueryError(
        `No sync entity type maps to collection "${name}"`,
      );
    }
    const state: CollectionBufferState = {
      name,
      entityType,
      buffered: new Map(),
      remoteCache: new Map(),
    };
    this.states.set(name, state);
    return state;
  }

  private statesInEntityTypeOrder(): readonly CollectionBufferState[] {
    const ordered: CollectionBufferState[] = [];
    for (const entityType of ENTITY_TYPES_IN_ORDER) {
      const state = this.states.get(SYNC_COLLECTIONS[entityType]);
      if (state) {
        ordered.push(state);
      }
    }
    return ordered;
  }

  /**
   * Coalesced finance plan. Create-before-update stays one create, an update
   * followed by delete becomes one delete, and create-then-delete produced no
   * entry at all (the facade dropped it at buffer time). The update base is
   * always the cached remote row captured before the first patch, so the
   * expected record and the pre-write snapshot are the authoritative states.
   */
  private planFinanceRows(): PlannedFinanceRow[] {
    const planned: PlannedFinanceRow[] = [];
    for (const state of this.statesInEntityTypeOrder()) {
      if (state.buffered.size === 0) {
        continue;
      }
      const ids = [...state.buffered.keys()].sort();
      for (const id of ids) {
        const entry = state.buffered.get(id)!;
        if (entry.kind === 'create') {
          const record = entry.createData!;
          planned.push({
            write: {
              kind: 'create',
              entityType: state.entityType,
              collectionName: state.name,
              recordId: id,
              record,
            },
            body: record,
          });
          continue;
        }
        if (entry.kind === 'delete') {
          planned.push({
            write: {
              kind: 'delete',
              entityType: state.entityType,
              collectionName: state.name,
              recordId: id,
              record: null,
            },
            body: null,
          });
          continue;
        }
        const base = state.remoteCache.get(id);
        if (base === undefined || base === null) {
          throw new MutationPreconditionError(
            `Buffered update for ${state.entityType}:${id} lost its remote base before commit`,
          );
        }
        planned.push({
          write: {
            kind: 'update',
            entityType: state.entityType,
            collectionName: state.name,
            recordId: id,
            record: mergePatchOverlay(base, entry.patches),
          },
          body: coalescedPatchBody(entry.patches),
        });
      }
    }
    return planned;
  }

  private appendMetadata(
    method: 'create' | 'update',
    collectionName: string,
    recordId: string | undefined,
    body: PocketRecordRow,
  ): void {
    this.assertOpen();
    const isMetadata = METADATA_COLLECTION_PREFIXES.some((prefix) =>
      collectionName.startsWith(prefix),
    );
    if (!isMetadata) {
      throw new UnsupportedQueryError(
        `metadataBatch() is restricted to obol_sync_*/obol_station_* collections; "${collectionName}" is not`,
      );
    }
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      throw new MutationPreconditionError(
        `metadataBatch() body for ${collectionName} must be a plain object`,
      );
    }
    if (method === 'update' && typeof recordId !== 'string') {
      throw new MutationPreconditionError(
        `update entry for ${collectionName} requires the PocketBase record id`,
      );
    }
    this.metadataEntries.push({
      method,
      collectionName,
      ...(method === 'update' ? { recordId } : {}),
      body,
    });
  }

  /**
   * Enforces the pinned PocketBase batch capabilities before any request:
   * at most 60000 requests and a multipart body below the 48 MiB bound. The
   * measurement uses the exact JSON the SDK encodes (undefined omitted,
   * finite scalars only) plus a conservative framing margin.
   */
  private assertBatchCapacity(entries: readonly BatchEntry[]): void {
    if (entries.length > PB_BATCH_MAX_REQUESTS) {
      throw new MutationCapacityExceededError(
        'BATCH_REQUESTS',
        PB_BATCH_MAX_REQUESTS,
      );
    }
    const requests = entries.map((entry) => ({
      method:
        entry.method === 'create'
          ? 'POST'
          : entry.method === 'update'
            ? 'PATCH'
            : 'DELETE',
      url: `/api/collections/${encodeURIComponent(entry.collectionName)}/records${
        entry.recordId ? `/${encodeURIComponent(entry.recordId)}` : ''
      }`,
      body: toSyncJsonValue(
        entry.body ?? {},
        `batch body of ${entry.collectionName}`,
      ),
    }));
    const measured =
      canonicalJsonLength(
        toSyncJsonValue({ requests }, 'batch envelope'),
      ) + PB_BATCH_FRAMING_BYTES;
    if (measured >= PB_BATCH_MAX_BODY_BYTES) {
      throw new MutationCapacityExceededError(
        'BATCH_BYTES',
        PB_BATCH_MAX_BODY_BYTES,
      );
    }
  }

  private close(): void {
    this.closed = true;
    this.states.clear();
    this.metadataEntries.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Buffered collection facade
// ---------------------------------------------------------------------------

class BufferedCollectionFacade implements BufferedPocketbaseCollection {
  constructor(
    private readonly state: CollectionBufferState,
    private readonly uow: PocketbaseUnitOfWork,
  ) {}

  async getOne<T = unknown>(id: string): Promise<T> {
    const entry = this.state.buffered.get(id);
    if (entry?.kind === 'create') {
      return entry.createData as unknown as T;
    }
    if (entry?.kind === 'delete') {
      throw notFound404(id);
    }
    const remote = await this.uow.fetchRemoteRecord(this.state, id);
    if (remote === null) {
      throw notFound404(id);
    }
    if (entry?.kind === 'update') {
      return mergePatchOverlay(remote, entry.patches) as unknown as T;
    }
    return remote as unknown as T;
  }

  async getFirstListItem<T = unknown>(filter: string): Promise<T> {
    // Untouched collection: the exact PocketBase request is authoritative.
    if (this.state.buffered.size === 0) {
      return (await this.uow.fetchRemoteFirstRow(
        this.state,
        filter,
      )) as unknown as T;
    }
    // Buffered collection: PocketBase's "first item or 404" over the merged
    // set, ordered by id ascending (the merged default ordering).
    const rows = await this.mergedRows({ filter });
    if (rows.length === 0) {
      throw notFound404(filter);
    }
    return rows[0] as unknown as T;
  }

  async getList<T = unknown>(
    page: number,
    perPage: number,
    options?: SyncListViewOptions,
  ): Promise<PaginatedResult<T>> {
    if (!Number.isInteger(page) || page < 1) {
      throw new UnsupportedQueryError(
        `getList page must be a positive integer, got ${String(page)}`,
      );
    }
    if (
      !Number.isInteger(perPage) ||
      perPage < 1 ||
      perPage > PB_MAX_PAGE_SIZE
    ) {
      throw new UnsupportedQueryError(
        `getList perPage must be within 1..${PB_MAX_PAGE_SIZE}, got ${String(perPage)}`,
      );
    }
    // Untouched collection: authoritative server pagination, no full scan.
    if (this.state.buffered.size === 0) {
      return (await this.uow.fetchRemotePage(
        this.state,
        page,
        perPage,
        options,
      )) as unknown as PaginatedResult<T>;
    }
    const merged = await this.mergedRows(options);
    const start = (page - 1) * perPage;
    return {
      items: merged.slice(start, start + perPage) as unknown as T[],
      page,
      perPage,
      totalItems: merged.length,
      totalPages: Math.ceil(merged.length / perPage),
    };
  }

  async getFullList<T = unknown>(
    options?: SyncListViewOptions,
  ): Promise<T[]> {
    if (this.state.buffered.size === 0) {
      return (await this.uow.fetchRemoteRows(this.state, options)) as unknown as T[];
    }
    return (await this.mergedRows(options)) as unknown as T[];
  }

  async create<T = unknown>(data: PocketRecordRow): Promise<T> {
    assertPlainRecord(data, 'create');
    const providedId = data.id;
    if (
      providedId !== undefined &&
      providedId !== null &&
      providedId !== '' &&
      (typeof providedId !== 'string' || !isValidEntityId(providedId))
    ) {
      throw new UnsupportedQueryError(
        `create payload id "${String(providedId)}" is not a 15-character lowercase PocketBase id`,
      );
    }

    const explicitId =
      typeof providedId === 'string' && providedId !== '' ? providedId : null;
    let recordId: string;
    if (explicitId !== null) {
      recordId = explicitId;
    } else {
      const preferred = this.uow.preferredCreateId(this.state.name, data);
      recordId = preferred ?? this.uow.nextEntityId();
      let attempts = 0;
      while (
        this.state.buffered.has(recordId) ||
        (await this.uow.fetchRemoteRecord(this.state, recordId)) !== null
      ) {
        recordId = this.uow.nextEntityId();
        attempts += 1;
        if (attempts > 10_000) {
          throw new MutationPreconditionError(
            `No free entity id could be assigned to a ${this.state.entityType} create`,
          );
        }
      }
    }

    const existing = this.state.buffered.get(recordId);
    if (existing?.kind === 'delete') {
      throw new BufferedWriteConflictError(
        'ID_REUSED_AFTER_DELETE',
        `${this.state.entityType}:${recordId} was deleted earlier in this mutation; deleted ids are never reused (D016 D6)`,
      );
    }
    if (existing) {
      throw new BufferedWriteConflictError(
        'ENTITY_ID_TAKEN',
        `This mutation already writes ${this.state.entityType}:${recordId}`,
      );
    }
    const remote = await this.uow.fetchRemoteRecord(this.state, recordId);
    if (remote !== null) {
      throw new BufferedWriteConflictError(
        'ENTITY_ID_TAKEN',
        `${this.state.entityType}:${recordId} already exists remotely; id reuse is forbidden (D016 D2 rule 3)`,
      );
    }

    const createData: PocketRecordRow = { ...data, id: recordId };
    this.state.buffered.set(recordId, {
      kind: 'create',
      createData,
      patches: [],
    });
    return createData as unknown as T;
  }

  async update<T = unknown>(id: string, data: PocketRecordRow): Promise<T> {
    assertPlainRecord(data, 'update');
    if (typeof id !== 'string' || !isValidEntityId(id)) {
      throw new UnsupportedQueryError(
        `update id "${String(id)}" is not a valid PocketBase id`,
      );
    }

    const patch: PocketRecordRow = {};
    for (const key of Object.keys(data)) {
      // `id` is system-owned: PocketBase never accepts it in an update body
      // and the row's id already comes from the buffered base.
      if (key === 'id') {
        continue;
      }
      const value = data[key];
      // PocketBase never receives `undefined` fields; skip them exactly like
      // the SDK's JSON encoding.
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new UnsupportedQueryError(
        'update payload must contain at least one field',
      );
    }

    const entry = this.state.buffered.get(id);
    if (entry?.kind === 'create') {
      // A later write to the same created row stays one create.
      const createData = entry.createData!;
      for (const key of Object.keys(patch)) {
        createData[key] = patch[key];
      }
      return createData as unknown as T;
    }
    if (entry?.kind === 'delete') {
      throw notFound404(id);
    }

    const remote = await this.uow.fetchRemoteRecord(this.state, id);
    if (remote === null) {
      throw notFound404(id);
    }
    if (entry?.kind === 'update') {
      entry.patches.push(patch);
    } else {
      this.state.buffered.set(id, { kind: 'update', patches: [patch] });
    }
    return mergePatchOverlay(remote, [patch]) as unknown as T;
  }

  async delete(id: string): Promise<void> {
    if (typeof id !== 'string' || !isValidEntityId(id)) {
      throw new UnsupportedQueryError(
        `delete id "${String(id)}" is not a valid PocketBase id`,
      );
    }
    const entry = this.state.buffered.get(id);
    if (entry?.kind === 'create') {
      // Create-then-delete coalesces to nothing: no row, no event and no
      // version row about that entity ever leaves this mutation.
      this.state.buffered.delete(id);
      return;
    }
    const remote = await this.uow.fetchRemoteRecord(this.state, id);
    if (remote === null) {
      throw notFound404(id);
    }
    this.state.buffered.set(id, { kind: 'delete', patches: [] });
  }

  /**
   * Bounded two-stage merged query. A collection without buffered rows is
   * served directly by PocketBase (the facade never reaches here in that
   * case). Otherwise stage one fetches the complete remote rows under the same
   * sort/filter/expand without `fields`, stage two overlays the local buffer,
   * re-evaluates the filter, re-sorts by the same segments and projects the
   * final rows. Read-your-writes stays exact without inventing a second query
   * language.
   */
  private async mergedRows(
    options?: SyncListViewOptions,
  ): Promise<PocketRecordRow[]> {
    const sort = parseSort(options?.sort);
    const filterNode = options?.filter ? parseFilter(options.filter) : null;
    const projection = parseFieldsProjection(options?.fields);
    const remoteOptions: SyncListViewOptions = {
      ...(options?.sort ? { sort: options.sort } : {}),
      ...(options?.filter ? { filter: options.filter } : {}),
      ...(options?.expand ? { expand: options.expand } : {}),
    };

    const base = await this.uow.fetchMergeRows(this.state, remoteOptions);
    const matched = new Map<string, PocketRecordRow>();
    const baseIds = new Set<string>();

    for (const row of base) {
      const id = String(row.id);
      baseIds.add(id);
      const entry = this.state.buffered.get(id);
      if (entry?.kind === 'delete') {
        continue;
      }
      const overlay =
        entry?.kind === 'update' ? mergePatchOverlay(row, entry.patches) : row;
      if (filterNode === null || evaluateFilter(overlay, filterNode)) {
        matched.set(id, overlay);
      }
    }

    // Buffered updates whose remote base the remote filter excluded: the
    // patch may have moved the row into the result set. The pre-patch base is
    // always cached (fetched when the first patch was buffered).
    for (const [id, entry] of this.state.buffered) {
      if (entry.kind !== 'update' || matched.has(id) || baseIds.has(id)) {
        continue;
      }
      const remoteBase = this.state.remoteCache.get(id);
      if (remoteBase === undefined || remoteBase === null) {
        continue;
      }
      const overlay = mergePatchOverlay(remoteBase, entry.patches);
      if (filterNode === null || evaluateFilter(overlay, filterNode)) {
        matched.set(id, overlay);
      }
    }

    // Buffered creates are evaluated on the local record.
    for (const [id, entry] of this.state.buffered) {
      if (entry.kind !== 'create' || matched.has(id)) {
        continue;
      }
      const record = entry.createData!;
      if (filterNode === null || evaluateFilter(record, filterNode)) {
        matched.set(id, record);
      }
    }

    const rows = [...matched.values()];
    if (sort.length === 0) {
      // Documented merged default: unsorted queries merge ordered by id.
      rows.sort((left, right) =>
        compareSortableValues(
          recordValueOf(left, 'id'),
          recordValueOf(right, 'id'),
        ),
      );
    } else {
      rows.sort((left, right) => compareRecordsWithSort(left, right, sort));
    }

    if (projection.length === 0 || projection[0] === '*') {
      return rows;
    }
    return rows.map((row) => projectRecord(row, projection));
  }
}

/** Rejects a non-object payload before it reaches the buffer. */
function assertPlainRecord(
  data: unknown,
  verb: 'create' | 'update',
): asserts data is PocketRecordRow {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new UnsupportedQueryError(`${verb} payload must be a plain object`);
  }
}
