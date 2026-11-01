// Secure record and operation identifiers (D016 D2 rules 1/3, canon §12.5).
//
// Infrastructure-only helpers: the unit of work assigns a PocketBase record id
// when a create payload omits one, and the mutation coordinator/station
// recorder generates operation and commit ids.
//
// - Entity ids are exactly 15 lowercase alphanumeric characters, the domain
//   pattern `^[a-z0-9]{15}$` (`SYNC_ENTITY_ID_PATTERN`), which is also the id
//   shape PocketBase accepts for client-chosen record ids.
// - Randomness comes only from the OS CSPRNG (`node:crypto.randomBytes`).
//   Sampling uses rejection: a byte is accepted only below 252, the largest
//   multiple of the 36-character alphabet that fits in one byte, so every
//   character is exactly equally likely. Rejected bytes are discarded, never
//   reduced modulo the alphabet (which would bias the first characters).
// - `newOperationId()` is an RFC 9562 UUIDv7: a 48-bit unix millisecond
//   prefix, version nibble 7, RFC variant `10xx`, and 74 CSPRNG bits. Ids are
//   time-ordered, so an outbox sorted by opId is also creation-ordered.

import { randomBytes } from 'node:crypto';

import {
  SYNC_ENTITY_ID_LENGTH,
  type SyncEntityId,
} from '../../domain/sync/SyncRevision';

const SYNC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Largest byte value that maps uniformly onto the 36-character alphabet:
 * `Math.floor(256 / 36) * 36 === 252`. Bytes 252..255 are rejected.
 */
const SYNC_ALPHABET_BYTE_LIMIT = 252;

const UUID_BYTES = 16;
const UUID_MAX_TIMESTAMP = 0xffff_ffff_ffff;

/** Two-digit lowercase hex for every byte, indexed by its value. */
const HEX_BYTE = new Array<string>(256);
for (let value = 0; value < 256; value += 1) {
  HEX_BYTE[value] = value.toString(16).padStart(2, '0');
}

/** Validates an existing PocketBase record id (15 lowercase alphanumerics). */
export function isValidEntityId(value: string): boolean {
  return /^[a-z0-9]{15}$/.test(value);
}

/** Formats 16 bytes as the canonical lowercase UUID string. */
export function formatUuid(bytes: Uint8Array): string {
  if (bytes.length !== UUID_BYTES) {
    throw new Error(
      `Cannot format a UUID from ${bytes.length} bytes; exactly 16 are required`,
    );
  }
  let out = '';
  for (let index = 0; index < UUID_BYTES; index += 1) {
    out += HEX_BYTE[bytes[index]!]!;
    // Dash after bytes 3, 5, 7 and 9: 8-4-4-4-12 grouping.
    if (index === 3 || index === 5 || index === 7 || index === 9) {
      out += '-';
    }
  }
  return out;
}

/**
 * Generates one UUIDv7 from the system clock plus 16 CSPRNG bytes. A clock
 * outside the 48-bit millisecond range fails loudly rather than emitting a
 * malformed or truncated id.
 */
export function newOperationId(): string {
  const timestamp = Date.now();
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > UUID_MAX_TIMESTAMP) {
    throw new Error(
      `Cannot build a UUIDv7 from the system time ${String(timestamp)}; the 48-bit unix millisecond range is required`,
    );
  }

  const bytes = randomBytes(UUID_BYTES);

  // JavaScript masks shift counts to 31 bits, so `timestamp >>> 40` and
  // `timestamp >>> 32` would repeat the low word. Derive the two highest
  // bytes by exact division; the remaining four fit in 32-bit shifts.
  bytes[0] = Math.floor(timestamp / 2 ** 40) % 256;
  bytes[1] = Math.floor(timestamp / 2 ** 32) % 256;
  bytes[2] = (timestamp >>> 24) & 0xff;
  bytes[3] = (timestamp >>> 16) & 0xff;
  bytes[4] = (timestamp >>> 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7: high nibble of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC variant 10xx: the two high bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return formatUuid(bytes);
}

/**
 * Generates one secure 15-character lowercase alphanumeric entity id from
 * uniform CSPRNG sampling.
 */
export function newSyncEntityId(): SyncEntityId {
  let id = '';
  while (id.length < SYNC_ENTITY_ID_LENGTH) {
    const remaining = SYNC_ENTITY_ID_LENGTH - id.length;
    const bytes = randomBytes(remaining);
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index]!;
      if (byte >= SYNC_ALPHABET_BYTE_LIMIT) {
        continue;
      }
      id += SYNC_ALPHABET[byte % SYNC_ALPHABET.length];
      if (id.length === SYNC_ENTITY_ID_LENGTH) {
        break;
      }
    }
  }
  return id;
}
