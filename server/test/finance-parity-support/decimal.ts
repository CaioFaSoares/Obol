// Exact decimal helpers for fixture money.
//
// The adapter must hand the product the raw decimal value and compare outputs
// by exact decimal representation. Nothing here rounds, rescales, or formats
// with `toFixed`; the product owns rounding.

export class DecimalFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalFormatError';
  }
}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_DECIMAL_SCALE = 30;
const MAX_DECIMAL_DIGITS = 60;

interface DecimalParts {
  negative: boolean;
  digits: string;
  scale: number;
}

function parseDecimal(value: string | number): DecimalParts {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DecimalFormatError(`Money value is not finite: ${String(value)}`);
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    throw new DecimalFormatError(`Money value must be a string or number, got ${typeof value}`);
  }

  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new DecimalFormatError(`Invalid decimal value "${text}"`);
  }

  const negative = match[1] === '-';
  const integerPart = match[2];
  const fractionPart = match[3] ?? '';
  const exponent = match[4] ? Number(match[4]) : 0;

  let digits = integerPart + fractionPart;
  let scale = fractionPart.length - exponent;

  if (!Number.isInteger(scale) || Math.abs(scale) > MAX_DECIMAL_SCALE) {
    throw new DecimalFormatError(`Decimal scale is outside the supported range: "${text}"`);
  }

  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }

  digits = digits.replace(/^0+(?=\d)/, '');
  if (digits.length > MAX_DECIMAL_DIGITS) {
    throw new DecimalFormatError(`Decimal has too many digits: "${text}"`);
  }

  if (/^0+$/.test(digits)) {
    return { negative: false, digits: '0', scale: 0 };
  }

  return { negative, digits, scale };
}

function canonicalFromParts(parts: DecimalParts): string {
  let { digits, scale } = parts;
  while (scale > 0 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    scale -= 1;
  }
  if (/^0+$/.test(digits)) return '0';

  let text: string;
  if (scale === 0) {
    text = digits;
  } else if (digits.length <= scale) {
    text = `0.${'0'.repeat(scale - digits.length)}${digits}`;
  } else {
    text = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return parts.negative ? `-${text}` : text;
}

/** True when the value is a plain decimal string (no exponent, no whitespace). */
export function isMoneyString(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
}

/** Canonical exact decimal form; trailing fractional zeros are removed. */
export function canonicalDecimal(value: string | number): string {
  return canonicalFromParts(parseDecimal(value));
}

/** Raw product input: the exact numeric value of the fixture string. */
export function moneyToProductNumber(value: string): number {
  if (!isMoneyString(value)) {
    throw new DecimalFormatError(`Money input must be a decimal string, got ${JSON.stringify(value)}`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new DecimalFormatError(`Money input is not finite: ${value}`);
  }
  return numeric;
}

interface ScaledDecimal {
  value: bigint;
  scale: number;
}

function toScaled(parts: DecimalParts): ScaledDecimal {
  const magnitude = BigInt(parts.digits);
  return {
    value: parts.negative ? -magnitude : magnitude,
    scale: parts.scale,
  };
}

function rescale(value: ScaledDecimal, scale: number): bigint {
  if (scale === value.scale) return value.value;
  return value.value * 10n ** BigInt(scale - value.scale);
}

/** Compares two exact decimals. */
export function compareDecimal(left: string | number, right: string | number): -1 | 0 | 1 {
  const a = toScaled(parseDecimal(left));
  const b = toScaled(parseDecimal(right));
  const scale = Math.max(a.scale, b.scale);
  const av = rescale(a, scale);
  const bv = rescale(b, scale);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

/** Exact subtraction; the result is canonical and never rounded. */
export function subtractDecimal(left: string | number, right: string | number): string {
  const a = toScaled(parseDecimal(left));
  const b = toScaled(parseDecimal(right));
  const scale = Math.max(a.scale, b.scale);
  const difference = rescale(a, scale) - rescale(b, scale);

  if (difference === 0n) return '0';
  const negative = difference < 0n;
  const digits = (negative ? -difference : difference).toString();
  return canonicalFromParts({
    negative,
    digits,
    scale,
  });
}

/** True when the exact decimal is negative. */
export function isNegativeDecimal(value: string | number): boolean {
  return compareDecimal(value, '0') < 0;
}

/** Deterministic id ordering (ASCII), used for id-keyed set comparison. */
export function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
