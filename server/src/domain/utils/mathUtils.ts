/**
 * Currency math for a two-decimal money model.
 *
 * Values are stored and computed at two decimal places. A value exactly at a
 * half cent rounds toward positive infinity: 1.005 -> 1.01, -1.005 -> -1.00,
 * 10.075 -> 10.08.
 *
 * JavaScript binary floating point cannot express 1.005 exactly, so
 * `Math.round(value * 100)` evaluates `1.005 * 100` as `100.49999999999999`
 * and rounds the wrong way. This implementation reads the shortest
 * round-trip decimal form of the number, which is the value the caller wrote,
 * then performs the rounding on decimal digits. No decimal library is needed.
 */

const CURRENCY_DECIMALS = 2;

interface DecimalForm {
  negative: boolean;
  digits: string;
  point: number;
}

function toDecimalForm(value: number): DecimalForm {
  const text = Math.abs(value).toString();
  const [mantissa, exponentText] = text.split('e');
  const exponent = exponentText ? Number(exponentText) : 0;
  const [integerPart, fractionPart = ''] = mantissa.split('.');
  return {
    negative: value < 0,
    digits: integerPart + fractionPart,
    point: integerPart.length + exponent,
  };
}

function incrementDigits(digits: string): string {
  const chars = digits.split('');
  let index = chars.length - 1;
  while (index >= 0) {
    if (chars[index] === '9') {
      chars[index] = '0';
      index -= 1;
      continue;
    }
    chars[index] = String(Number(chars[index]) + 1);
    return chars.join('');
  }
  chars.unshift('1');
  return chars.join('');
}

function scaledDigitsToNumber(negative: boolean, scaledDigits: string): number {
  const trimmed = scaledDigits.replace(/^0+(?=\d)/, '');
  const text =
    trimmed.length <= CURRENCY_DECIMALS
      ? `0.${trimmed.padStart(CURRENCY_DECIMALS, '0')}`
      : `${trimmed.slice(0, -CURRENCY_DECIMALS)}.${trimmed.slice(-CURRENCY_DECIMALS)}`;
  const result = Number(text);
  return negative && result !== 0 ? -result : result;
}

/**
 * Rounds to two decimals with ties toward positive infinity.
 * Non-finite input is returned unchanged so callers can reject it.
 */
export function roundCurrency(value: number): number {
  if (!Number.isFinite(value)) return value;

  const { negative, digits, point } = toDecimalForm(value);
  const scaledPoint = point + CURRENCY_DECIMALS;

  let scaledDigits: string;
  let remainder: string;
  if (scaledPoint >= digits.length) {
    scaledDigits = digits + '0'.repeat(scaledPoint - digits.length);
    remainder = '';
  } else if (scaledPoint > 0) {
    scaledDigits = digits.slice(0, scaledPoint);
    remainder = digits.slice(scaledPoint);
  } else {
    scaledDigits = '0';
    remainder = '0'.repeat(-scaledPoint) + digits;
  }

  const first = remainder.charAt(0) || '0';
  const rest = remainder.slice(1);
  const aboveHalf = first > '5' || (first === '5' && /[1-9]/.test(rest));
  const atHalf = first === '5' && !/[1-9]/.test(rest);

  if (aboveHalf || (atHalf && !negative)) {
    scaledDigits = incrementDigits(scaledDigits);
  }

  return scaledDigitsToNumber(negative, scaledDigits);
}

/** Adds two monetary values without floating-point residue. */
export function sum(a: number, b: number): number {
  return roundCurrency(a + b);
}

/** Subtracts two monetary values without floating-point residue (a - b). */
export function sub(a: number, b: number): number {
  return roundCurrency(a - b);
}

/** Multiplies two monetary values and rounds the product. */
export function mul(a: number, b: number): number {
  return roundCurrency(a * b);
}
