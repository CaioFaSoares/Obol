import { afterEach, describe, expect, test } from 'bun:test';

import { newOperationId } from './RecordIds';

// Deterministic cover for the UUIDv7 48-bit millisecond prefix. The clock is
// the only controlled input; the CSPRNG bytes are never asserted, so nothing
// here depends on randomness.
//
// The regression this pins: `(timestamp >>> 40)` and `(timestamp >>> 32)`
// are wrong in JavaScript (shift counts are masked to 31 bits), which wrote
// the low word into the two high timestamp bytes and produced ids such as
// `95459520-9545-7f11-...` for a current clock.

const REAL_DATE_NOW = Date.now;

const UUID_GROUP_LENGTHS = [8, 4, 4, 4, 12] as const;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface DecodedUuid {
  /** The 16 raw bytes, in string order. */
  readonly bytes: readonly number[];
  /** The big-endian 48-bit unix millisecond prefix. */
  readonly timestamp: number;
}

/** Decodes the real generated string: groups, bytes, then the time prefix. */
function decodeUuid(value: string): DecodedUuid {
  expect(value).toMatch(CANONICAL_UUID);
  const groups = value.split('-');
  expect(groups).toHaveLength(UUID_GROUP_LENGTHS.length);
  const bytes: number[] = [];
  groups.forEach((group, index) => {
    expect(group).toHaveLength(UUID_GROUP_LENGTHS[index]!);
    for (let offset = 0; offset < group.length; offset += 2) {
      bytes.push(Number.parseInt(group.slice(offset, offset + 2), 16));
    }
  });
  expect(bytes).toHaveLength(16);
  let timestamp = 0;
  for (let index = 0; index < 6; index += 1) {
    timestamp = timestamp * 256 + bytes[index]!;
  }
  return { bytes, timestamp };
}

/** Runs `run` with `Date.now` pinned, restoring the real clock immediately. */
function withFixedClock<T>(timestamp: number, run: () => T): T {
  Date.now = () => timestamp;
  try {
    return run();
  } finally {
    Date.now = REAL_DATE_NOW;
  }
}

describe('newOperationId UUIDv7 timestamp prefix', () => {
  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  test('a current clock lands in the first 48 bits exactly', () => {
    const timestamp = 1_767_225_600_123; // 2026-01-01T00:00:00.123Z
    const decoded = withFixedClock(timestamp, () =>
      decodeUuid(newOperationId()),
    );
    expect(decoded.timestamp).toBe(timestamp);
  });

  test('timestamps around the 2^32 boundary keep both high bytes', () => {
    const timestamps = [
      0xff_ff_ff_bf, // 2^32 - 65: the observed malformed-id shape
      0xff_ff_ff_ff, // 2^32 - 1
      0x1_0000_0000, // 2^32
      0x1_0000_0001, // 2^32 + 1
    ];
    for (const timestamp of timestamps) {
      const decoded = withFixedClock(timestamp, () =>
        decodeUuid(newOperationId()),
      );
      expect(decoded.timestamp).toBe(timestamp);
    }
  });

  test('the largest valid 48-bit timestamp round-trips', () => {
    const timestamp = 0xffff_ffff_ffff;
    const decoded = withFixedClock(timestamp, () =>
      decodeUuid(newOperationId()),
    );
    expect(decoded.timestamp).toBe(timestamp);
    expect(decoded.bytes[0]).toBe(0xff);
    expect(decoded.bytes[1]).toBe(0xff);
  });

  test('generated ids carry the v7 version and RFC variant bits', () => {
    const decoded = withFixedClock(1_767_225_600_123, () =>
      decodeUuid(newOperationId()),
    );
    // Version 7: high nibble of byte 6.
    expect(decoded.bytes[6]! >> 4).toBe(7);
    // Variant 10xx: the two high bits of byte 8.
    expect(decoded.bytes[8]! & 0xc0).toBe(0x80);
  });
});
