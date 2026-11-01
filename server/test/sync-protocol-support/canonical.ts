// Independent client-side implementation of the sync protocol canonical JSON
// and hashing rules (D016 D2 rule 9 / orchestrator decision 2).
//
// This file is deliberately NOT imported from the product source: the hostile
// acceptance runner must prove the server accepts envelopes produced by a
// separate, boring implementation of the same documented format. The product
// canonical encoder is never used to build or verify a request here.
//
// Rules implemented:
// - object keys sorted recursively by JavaScript UTF-16 code-unit order;
// - UTF-8, no insignificant whitespace, standard JSON scalar encoding;
// - only finite numbers, strings, booleans, null, arrays and plain objects;
// - negative zero is emitted as `0` (standard JSON);
// - every non-empty hash is `sha256:` + unpadded base64url(SHA-256(bytes));
//   the genesis hash is the empty string.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

const HASH_PREFIX = 'sha256:';
const SHA256_BODY = /^[A-Za-z0-9_-]{43}$/;

function encodeScalar(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Canonical JSON rejected a non-finite number.');
      }
      return JSON.stringify(value);
    default:
      throw new TypeError(`Canonical JSON rejected a ${typeof value} value.`);
  }
}

function encodeValue(value: unknown, ancestors: Set<object>): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return encodeScalar(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON rejected a ${typeof value} value.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON rejected a cyclic structure.');
  }
  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      const parts = new Array<string>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        parts[index] = encodeValue(value[index], ancestors);
      }
      return `[${parts.join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical JSON rejected a non-plain object.');
  }
  ancestors.add(value);
  try {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    const parts = new Array<string>(keys.length);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      parts[index] = `${JSON.stringify(key)}:${encodeValue(source[key], ancestors)}`;
    }
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Canonical JSON text, exactly as the shared contract documents it. */
export function canonicalJson(value: unknown): string {
  return encodeValue(value, new Set());
}

/** `sha256:` + unpadded base64url over the canonical UTF-8 bytes. */
export function canonicalHash(value: unknown): string {
  return sha256HashOfText(canonicalJson(value));
}

export function sha256HashOfBytes(bytes: Uint8Array): string {
  return `${HASH_PREFIX}${createHash('sha256').update(bytes).digest('base64url')}`;
}

export function sha256HashOfText(text: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(text, 'utf8').digest('base64url')}`;
}

export function isSha256Hash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(HASH_PREFIX) &&
    SHA256_BODY.test(value.slice(HASH_PREFIX.length))
  );
}

/** Lowercase RFC 9562 UUIDv7 (the opId/importId namespace). */
export function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp >> BigInt(8 * (5 - index))) & 0xff;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Lowercase RFC 9562 UUIDv4, the shape a durable station identity takes when
 * the native keychain returns `UUID().uuidString`. The contract requires the
 * server to accept it; the current validator does not, and that failure is
 * reported instead of hidden.
 */
export function uuidV4(): string {
  return randomUUID();
}

const ENTITY_ID = /^[a-z0-9]{15}$/;
const ENTITY_ID_LENGTH = 15;

/**
 * Encodes one `prefix + counter` id. The counter is zero-padded to the exact
 * remaining width, so value boundaries are explicit: padding the whole string
 * made counter 1 and counter 36 (`"1"` and `"10"` in base36) produce the same
 * id, which collapsed 495 generated rows into 482 unique ids.
 */
function encodeEntityId(prefix: string, counter: number, label: string): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError(
      `The ${label} counter must be a non-negative safe integer, got ${counter}.`,
    );
  }
  const digits = ENTITY_ID_LENGTH - prefix.length;
  const encoded = counter.toString(36);
  if (digits < 1 || encoded.length > digits) {
    throw new TypeError(
      `The ${label} counter ${counter} does not fit the prefix "${prefix}".`,
    );
  }
  const id = `${prefix}${encoded.padStart(digits, '0')}`;
  if (!ENTITY_ID.test(id)) {
    throw new TypeError(`The ${label} produced an invalid id "${id}".`);
  }
  return id;
}

/**
 * Deterministic PocketBase-compatible 15-character entity ids for one
 * namespace. Prefixes are short and lowercase; the counter is base36 so two
 * runs of the suite mint the same synthetic ids and a failed cleanup is easy
 * to spot.
 */
export function entityIdFactory(prefix: string): () => string {
  if (!/^[a-z0-9]{1,8}$/.test(prefix)) {
    throw new TypeError('An entity id prefix must be 1..8 lowercase alphanumerics.');
  }
  let counter = 0;
  return () => {
    counter += 1;
    return encodeEntityId(prefix, counter, 'entity id factory');
  };
}

/** Fixed fixture id, 15 lowercase alphanumerics. */
export function fixedEntityId(prefix: string, index: number): string {
  if (!/^[a-z0-9]{1,10}$/.test(prefix)) {
    throw new TypeError('A fixture id prefix must be 1..10 lowercase alphanumerics.');
  }
  return encodeEntityId(prefix, index, 'fixture id');
}

export function isEntityId(value: unknown): value is string {
  return typeof value === 'string' && ENTITY_ID.test(value);
}

/** UTC `YYYY-MM-DD` for a day offset relative to now. */
export function utcDayOffset(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** True when two stored/declared timestamps name the same instant. */
export function sameInstant(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftMs = Date.parse(left.replace(' ', 'T'));
  const rightMs = Date.parse(right.replace(' ', 'T'));
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

/** Deep JSON equality for declared fixture comparisons (stable stringify). */
export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
