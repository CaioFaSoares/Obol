// Deterministic canonical JSON and every canonical hash used by the sync
// contract (D016 D2 rule 9, canon §12.2). This module is the single
// framework-free implementation of the hashing rules; nothing else
// re-implements them.
//
// Canonical JSON rules:
// - object keys are sorted recursively at every depth by JavaScript UTF-16
//   code-unit order (`Array#sort` on the own string keys), at every depth;
// - the output is UTF-8, has no insignificant whitespace and uses the
//   standard JSON scalar encoding (`JSON.stringify` per scalar);
// - only finite numbers, strings, booleans, `null`, arrays and plain objects
//   are representable. `undefined`, functions, symbols, bigints, class
//   instances and cyclic structures are rejected loudly instead of being
//   coerced or silently dropped;
// - negative zero is encoded as `0` (the standard JSON encoding).
//
// Hash rules:
// - every non-empty hash is `sha256:` + unpadded base64url of the SHA-256 of
//   the canonical UTF-8 bytes; the empty genesis hash is `''`;
// - `recordHash(null)` hashes the JSON literal `null`: a delete tombstone is
//   a real value, not a genesis state. Only `prevHash`/`headHash`/
//   `cursorHash` before the first journal event are the empty genesis hash;
// - the complete-envelope hash (`payloadHash` on the wire) covers exactly the
//   eleven fields of `SYNC_ENVELOPE_HASH_FIELDS` and never the transmitted
//   `payloadHash` field itself; an absent `dependsOn` is `[]` and an absent
//   `baseRevisions` is `{}`;
// - the chain hash input is exactly `SYNC_CHAIN_HASH_FIELDS` (fourteen
//   fields); an absent optional `stationId`/`opId` is encoded as JSON `null`,
//   and `eventKey` is not hashed;
// - hashed timestamps are normalized to `Date#toISOString()` form
//   (`YYYY-MM-DDTHH:mm:ss.sssZ`). PocketBase `date` columns use a space
//   separator and an omitted or over-long fraction, so they are normalized on
//   the way in; raw storage text never enters a hash.

import { createHash } from 'node:crypto';

import {
  SYNC_CHAIN_HASH_FIELDS,
  type SyncChainHashInput,
} from '../../domain/sync/SyncChange';
import { SYNC_ENVELOPE_HASH_FIELDS } from '../../domain/sync/SyncOperation';
import {
  SYNC_GENESIS_HASH,
  SYNC_HASH_PREFIX,
  type SyncHash,
  type SyncJsonObject,
  type SyncJsonValue,
  type SyncRecord,
  type SyncSha256Hash,
} from '../../domain/sync/SyncRevision';

const UTF8_ENCODER = new TextEncoder();

/** Unpadded base64url of a 32-byte SHA-256 digest. */
const SHA256_BASE64URL_LENGTH = 43;

/** Exact shape of every non-empty hash. */
const SYNC_SHA256_HASH_PATTERN = new RegExp(
  `^${SYNC_HASH_PREFIX}[A-Za-z0-9_-]{${SHA256_BASE64URL_LENGTH}}$`,
);

/**
 * ISO-8601 timestamp with an explicit zone. The fraction is optional and may
 * be 1..9 digits; it is truncated (never rounded) to the millisecond
 * precision the canonical form carries.
 */
const SYNC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Rejection for a value the canonical JSON cannot represent. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Encodes one scalar. `undefined`, functions, symbols and bigints reach the
 * default branch and fail; numbers are checked for finiteness first because
 * `JSON.stringify(NaN)` would silently emit `null`.
 */
function encodeScalar(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      // Both serialize to a defined string; the overload just admits undefined.
      return JSON.stringify(value)!;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          `Canonical JSON rejects the non-finite number ${String(value)}`,
        );
      }
      // Shortest round-trip platform form; `JSON.stringify(-0)` is `"0"`.
      return JSON.stringify(value)!;
    default:
      throw new CanonicalJsonError(
        `Canonical JSON rejects ${typeof value} values`,
      );
  }
}

/**
 * Recursively encodes one JSON value. `ancestors` holds only the objects on
 * the current path, so a value shared by two sibling branches is legal while
 * a true cycle fails.
 */
function encode(value: unknown, ancestors: Set<object>): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return encodeScalar(value);
  }

  if (typeof value !== 'object') {
    throw new CanonicalJsonError(
      `Canonical JSON rejects ${typeof value} values`,
    );
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError('Canonical JSON rejects cyclic structures');
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      const parts = new Array<string>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        // A hole reads as `undefined` and fails loudly, exactly like an
        // explicit `undefined` element.
        parts[index] = encode(value[index], ancestors);
      }
      return `[${parts.join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(
      'Canonical JSON rejects non-plain objects (class instances, dates, maps)',
    );
  }

  ancestors.add(value);
  try {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    const parts = new Array<string>(keys.length);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      parts[index] = `${JSON.stringify(key)}:${encode(source[key], ancestors)}`;
    }
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Canonical JSON text of a sync value: UTF-8 bytes when encoded, keys sorted
 * recursively, zero insignificant whitespace. Unrepresentable values fail
 * loudly.
 */
export function canonicalJson(value: SyncJsonValue): string {
  return encode(value, new Set());
}

/**
 * UTF-8 byte length of `canonicalJson(value)`, the pre-write capacity proxy.
 * The canonical form is already a string, so the platform measures its
 * encoded size without building a second copy.
 */
export function canonicalJsonLength(value: SyncJsonValue): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

/** UTF-8 bytes of the canonical form, the input of every canonical hash. */
export function canonicalJsonBytes(value: SyncJsonValue): Uint8Array {
  return UTF8_ENCODER.encode(canonicalJson(value));
}

/** `sha256:` + unpadded base64url over raw bytes. */
export function sha256HashOfBytes(bytes: Uint8Array): SyncSha256Hash {
  return `${SYNC_HASH_PREFIX}${createHash('sha256').update(bytes).digest('base64url')}`;
}

/** `sha256:` + unpadded base64url over the UTF-8 bytes of `text`. */
export function sha256HashOfText(text: string): SyncSha256Hash {
  return `${SYNC_HASH_PREFIX}${createHash('sha256').update(text, 'utf8').digest('base64url')}`;
}

/** `sha256:` + unpadded base64url over the canonical JSON bytes of `value`. */
export function canonicalHash(value: SyncJsonValue): SyncSha256Hash {
  return sha256HashOfText(canonicalJson(value));
}

/** True when `value` is a well-formed `sha256:` + unpadded base64url hash. */
export function isSyncSha256Hash(value: unknown): value is SyncSha256Hash {
  return typeof value === 'string' && SYNC_SHA256_HASH_PATTERN.test(value);
}

/**
 * Validates one stored or transmitted hash: either the empty genesis hash
 * before the first event, or a canonical `sha256:` hash. Journal, meta and
 * receipt reads use this instead of trusting an arbitrary column string.
 */
export function parseSyncHash(value: unknown, context: string): SyncHash {
  if (value === SYNC_GENESIS_HASH) {
    return SYNC_GENESIS_HASH;
  }
  return parseSyncSha256Hash(value, context);
}

/** Validates one stored or transmitted non-genesis hash. */
export function parseSyncSha256Hash(
  value: unknown,
  context: string,
): SyncSha256Hash {
  if (!isSyncSha256Hash(value)) {
    throw new CanonicalJsonError(
      `${context} must be ${SYNC_HASH_PREFIX} followed by ${SHA256_BASE64URL_LENGTH} unpadded base64url characters, got ${
        typeof value === 'string' ? JSON.stringify(value) : String(value)
      }`,
    );
  }
  return value;
}

/**
 * Converts a runtime value into the JSON value that PocketBase actually
 * writes and every hash covers: arrays and plain objects of finite scalars.
 * Object properties whose value is `undefined` are omitted exactly like the
 * JSON encoding of the PocketBase SDK; every other non-JSON value (function,
 * symbol, bigint, class instance, cyclic structure) fails loudly with the
 * supplied context instead of being coerced or silently dropped.
 */
export function toSyncJsonValue(value: unknown, context: string): SyncJsonValue {
  return toJsonValue(value, context, new Set());
}

function toJsonValue(
  value: unknown,
  context: string,
  ancestors: Set<object>,
): SyncJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(
        `${context} is a non-finite number: ${String(value)}`,
      );
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new CanonicalJsonError(
      `${context} is a ${typeof value} value, which JSON cannot represent`,
    );
  }
  if (ancestors.has(value)) {
    throw new CanonicalJsonError(`${context} contains a cyclic structure`);
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    ancestors.add(value);
    try {
      const parts = new Array<SyncJsonValue>(items.length);
      for (let index = 0; index < items.length; index += 1) {
        parts[index] = toJsonValue(
          items[index],
          `${context}[${index}]`,
          ancestors,
        );
      }
      return parts;
    } finally {
      ancestors.delete(value);
    }
  }
  return toJsonObjectValue(value, context, ancestors);
}

/** Converts the entries of one plain object, rejecting every non-JSON field. */
function toJsonObjectValue(
  value: object,
  context: string,
  ancestors: Set<object>,
): SyncJsonObject {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(`${context} is not a plain JSON object`);
  }
  const source = value as Record<string, unknown>;
  ancestors.add(value);
  try {
    const converted: Record<string, SyncJsonValue> = {};
    for (const key of Object.keys(source)) {
      const entry = source[key];
      if (entry === undefined) {
        continue;
      }
      converted[key] = toJsonValue(entry, `${context}.${key}`, ancestors);
    }
    return converted;
  } finally {
    ancestors.delete(value);
  }
}

/** Converts a plain JSON object (record, row, result) into `SyncJsonObject`. */
export function toSyncJsonObject(
  value: unknown,
  context: string,
): SyncJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanonicalJsonError(`${context} must be a JSON object`);
  }
  return toJsonObjectValue(value, context, new Set());
}

/**
 * Normalizes one timestamp to the exact form used in hashed inputs:
 * `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, millisecond precision). Accepts the
 * PocketBase `date` serialization (space separator, omitted or over-long
 * fraction) and any explicit zone while preserving the instant. A value that
 * is not a timestamp fails loudly, so a malformed clock or column can never
 * enter a chain hash.
 */
export function normalizeSyncTimestamp(value: unknown, context: string): string {
  const match =
    typeof value === 'string' ? SYNC_TIMESTAMP_PATTERN.exec(value) : null;
  if (!match) {
    throw new CanonicalJsonError(
      `${context} is not an ISO-8601 timestamp, got ${
        typeof value === 'string' ? JSON.stringify(value) : String(value)
      }`,
    );
  }
  const fraction = (match[3] ?? '').padEnd(3, '0').slice(0, 3);
  const parsed = new Date(`${match[1]!}T${match[2]!}.${fraction}${match[4]!}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new CanonicalJsonError(
      `${context} is not a parseable timestamp: ${JSON.stringify(value)}`,
    );
  }
  return parsed.toISOString();
}

/**
 * Canonical record hash of the complete record. A `null` record (delete
 * tombstone) hashes the JSON literal `null`; it is a real value, not a
 * genesis state. The empty genesis hash belongs only to
 * `prevHash`/`headHash`/`cursorHash` before the first event.
 */
export function recordHash(record: SyncRecord | null): SyncSha256Hash {
  return canonicalHash(record);
}

/**
 * Structural shape accepted by `operationEnvelopeHash`: every hashed envelope
 * field mapped to `unknown` so a complete or partially built envelope is
 * accepted and validated field by field.
 */
type SyncEnvelopeField = (typeof SYNC_ENVELOPE_HASH_FIELDS)[number];
export type SyncEnvelopeHashable = {
  readonly [K in SyncEnvelopeField]: unknown;
};

/**
 * Complete-envelope hash (`payloadHash` on the wire): `sha256:` over the
 * canonical JSON of exactly the eleven `SYNC_ENVELOPE_HASH_FIELDS`, never the
 * transmitted `payloadHash` field itself. An absent optional `dependsOn` is
 * encoded as `[]`; an absent optional `baseRevisions` as `{}`.
 */
export function operationEnvelopeHash(
  envelope: SyncEnvelopeHashable,
): SyncSha256Hash {
  const complete: Record<string, SyncJsonValue> = {};
  for (const field of SYNC_ENVELOPE_HASH_FIELDS) {
    const value = envelope[field];
    if (field === 'dependsOn') {
      complete[field] = toSyncJsonValue(
        value === undefined || value === null ? [] : value,
        `envelope field "${field}"`,
      );
      continue;
    }
    if (field === 'baseRevisions') {
      complete[field] = toSyncJsonValue(
        value === undefined || value === null ? {} : value,
        `envelope field "${field}"`,
      );
      continue;
    }
    if (value === undefined) {
      throw new CanonicalJsonError(
        `Envelope hash input is missing the required field "${field}"`,
      );
    }
    complete[field] = toSyncJsonValue(value, `envelope field "${field}"`);
  }
  return canonicalHash(complete);
}

/**
 * Canonical chain hash of one change event over exactly
 * `SYNC_CHAIN_HASH_FIELDS`. `recordHash` must already be the canonical hash
 * of the record (including the literal `null` for a delete), and absent
 * optional `stationId`/`opId` must be `null`.
 */
export function changeChainHash(input: SyncChainHashInput): SyncSha256Hash {
  const complete: Record<string, SyncJsonValue> = {};
  for (const field of SYNC_CHAIN_HASH_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      throw new CanonicalJsonError(
        `Chain hash input is missing the required field "${field}"`,
      );
    }
    complete[field] = toSyncJsonValue(value, `chain hash field "${field}"`);
  }
  return canonicalHash(complete);
}
