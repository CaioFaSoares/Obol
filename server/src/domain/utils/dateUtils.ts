/**
 * UTC calendar helpers for financial dates.
 *
 * Every stored instant is an ISO UTC string. Calendar keys are separate:
 * `YYYY-MM` for invoice and recurrence periods and `YYYY-MM-DD` for daily
 * projections. Nothing here reads the wall clock; callers pass the instant
 * from the injected sync clock.
 */

import { ValidationError } from '../errors';

const MS_PER_DAY = 86_400_000;

/** Parses an ISO instant and normalizes it to UTC midnight. */
export function startOfUtcDay(value: string | Date): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(value.getTime());
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0)
  );
}

/** Parses an ISO instant and normalizes it to the first day of its UTC month. */
export function startOfUtcMonth(value: string | Date): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(value.getTime());
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * UTC midnight of the Monday of the ISO week that contains `value`.
 *
 * `getUTCDay()` is Sunday 0 … Saturday 6, so the Monday offset is `day - 1`
 * and a Sunday walks back six days.
 */
export function startOfIsoWeek(value: string | Date): Date {
  const day = startOfUtcDay(value);
  const offset = day.getUTCDay() === 0 ? 6 : day.getUTCDay() - 1;
  return addUtcDays(day, -offset);
}

/**
 * UTC midnight instant of the `weekday` occurrence (ISO 1..7) in the week that
 * contains `value`. Weekly occurrences are exact: every ISO week has all seven
 * days, so nothing is clamped.
 */
export function isoWeekOccurrence(value: string | Date, weekday: number): string {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw new ValidationError('The recurrence weekday must be a whole number between 1 and 7.');
  }
  return addUtcDays(startOfIsoWeek(value), weekday - 1).toISOString();
}

/** Adds whole UTC days. */
export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Adds whole UTC months, clamping to the target month length. */
export function addUtcMonths(date: Date, months: number): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = daysInUtcMonth(target.getUTCFullYear(), target.getUTCMonth());
  return new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    Math.min(date.getUTCDate(), lastDay),
    0, 0, 0, 0
  ));
}

/** Number of days in a UTC month. `month` is 0-based. */
export function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** `YYYY-MM` key of a UTC instant. */
export function monthKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` key of a UTC instant. */
export function dayKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Shifts a `YYYY-MM` period key by whole months. */
export function addMonthsToPeriod(period: string, months: number): string {
  const [year, month] = period.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return monthKey(shifted);
}

/**
 * Purchase date -> invoice due date. Purchases on or after the closing day
 * enter the next invoice, and a due day earlier than the closing day falls in
 * the month after the close. Month and year rollover are handled in UTC.
 */
export function calculateCardDueDate(transactionDateStr: string, closingDay: number, dueDay: number): string {
  const txnDate = new Date(transactionDateStr);
  let monthOffset = 0;

  const txnDay = txnDate.getUTCDate();
  if (txnDay >= closingDay) monthOffset += 1;
  if (dueDay < closingDay) monthOffset += 1;

  const dueDate = new Date(Date.UTC(
    txnDate.getUTCFullYear(),
    txnDate.getUTCMonth() + monthOffset,
    dueDay
  ));
  return dueDate.toISOString();
}

/** Instant at which an invoice stops accepting new purchases (UTC end of closing day). */
export function calculateClosingDate(dueDateStr: string, closingDay: number, dueDay: number): Date {
  const dueDate = new Date(dueDateStr);
  let closingMonth = dueDate.getUTCMonth();
  let closingYear = dueDate.getUTCFullYear();

  if (closingDay > dueDay) {
    closingMonth -= 1;
    if (closingMonth < 0) {
      closingMonth = 11;
      closingYear -= 1;
    }
  }

  return new Date(Date.UTC(closingYear, closingMonth, closingDay, 23, 59, 59, 999));
}

/** Boundaries of the UTC month that contains `now`. */
export function getCurrentMonthBoundaries(now: Date) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const lastDay = daysInUtcMonth(year, month);

  const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)).toISOString();
  const endOfMonth = new Date(Date.UTC(year, month, lastDay, 23, 59, 59, 999)).toISOString();

  return { startOfMonth, endOfMonth, year, month, lastDay };
}

/** Clamped UTC date string; `month` is 0-based. */
export function calculateClampedDate(year: number, month: number, targetDay: number, lastDayOfMonth: number): string {
  const safeDay = Math.min(targetDay, lastDayOfMonth);
  return new Date(Date.UTC(year, month, safeDay, 0, 0, 0, 0)).toISOString();
}

/**
 * Stored invoice status after a mutation: PAID once every child is realized
 * (or the invoice was already paid), CLOSED past the closing instant, else
 * OPEN. Projection status for a virtual invoice stays separate.
 */
export function determineInvoiceStatus(
  transactions: { status: string }[],
  dueDateStr: string,
  closingDay: number,
  dueDay: number,
  now: Date,
  storedStatus?: 'OPEN' | 'CLOSED' | 'PAID'
): 'OPEN' | 'CLOSED' | 'PAID' {
  if (storedStatus === 'PAID') return 'PAID';
  if (transactions.length > 0 && transactions.every(t => t.status === 'realized')) return 'PAID';

  const closingDate = calculateClosingDate(dueDateStr, closingDay, dueDay);
  return now > closingDate ? 'CLOSED' : 'OPEN';
}
