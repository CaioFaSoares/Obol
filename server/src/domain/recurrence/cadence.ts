/**
 * Recurrence cadence: the one branch between the monthly rule table and the
 * weekly ISO-week rule table (canon §6, D019).
 *
 * Instants are UTC only. A monthly occurrence is the clamped `payday` of a UTC
 * month and its period key is `YYYY-MM`. A weekly occurrence is the chosen ISO
 * weekday of a UTC ISO week (Monday 00:00 to Sunday 23:59:59.999) and its
 * period key is the occurrence day `YYYY-MM-DD`. Nothing is clamped weekly.
 */

import type { Recurrence } from '../entities/Recurrence';
import { ValidationError } from '../errors';
import {
  addUtcDays,
  calculateClampedDate,
  dayKey,
  daysInUtcMonth,
  isoWeekOccurrence,
  monthKey,
  startOfIsoWeek,
  startOfUtcMonth
} from '../utils/dateUtils';

export type RecurrenceCadence = 'monthly' | 'weekly';

/** Absent, empty and `null` frequency all mean the historical monthly cadence. */
export function recurrenceCadence(rec: { frequency?: 'monthly' | 'weekly' }): RecurrenceCadence {
  return rec.frequency === 'weekly' ? 'weekly' : 'monthly';
}

/** Occurrence period identity: the UTC month `YYYY-MM` or the day `YYYY-MM-DD`. */
export function recurrencePeriodKey(
  cadence: RecurrenceCadence,
  occurrence: string | Date
): string {
  return cadence === 'weekly' ? dayKey(occurrence) : monthKey(occurrence);
}

/**
 * Period identity of one stored child: the day (weekly) or the month
 * (monthly) of its purchase date, falling back to its expected date.
 */
export function recurrenceChildKey(
  rec: { frequency?: 'monthly' | 'weekly' },
  txn: { purchase_date?: string; expected_date: string }
): string {
  const reference = txn.purchase_date || txn.expected_date;
  return recurrencePeriodKey(recurrenceCadence(rec), reference);
}

/** The occurrence of the period that contains `instant`. */
export function recurrenceOccurrence(rec: Recurrence, instant: string | Date): string {
  if (recurrenceCadence(rec) === 'weekly') {
    return isoWeekOccurrence(instant, requireWeekday(rec));
  }
  const monthStart = startOfUtcMonth(instant);
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  return calculateClampedDate(year, month, rec.payday, daysInUtcMonth(year, month));
}

/** The occurrence of the period after the one that contains `instant`. */
export function nextRecurrenceOccurrence(rec: Recurrence, instant: string | Date): string {
  if (recurrenceCadence(rec) === 'weekly') {
    const nextWeek = addUtcDays(startOfIsoWeek(instant), 7);
    return isoWeekOccurrence(nextWeek, requireWeekday(rec));
  }
  const monthStart = startOfUtcMonth(instant);
  const target = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth();
  return calculateClampedDate(year, month, rec.payday, daysInUtcMonth(year, month));
}

function requireWeekday(rec: Recurrence): number {
  if (!Number.isInteger(rec.weekday) || (rec.weekday as number) < 1 || (rec.weekday as number) > 7) {
    throw new ValidationError('A weekly recurrence requires a weekday between 1 and 7.');
  }
  return rec.weekday as number;
}

export interface ResolvedRecurrenceCadence {
  readonly frequency: RecurrenceCadence;
  /** Stored weekday: the ISO day for weekly rows, undefined (stored `0`) monthly. */
  readonly weekday: number | undefined;
}

/**
 * Validates the requested cadence and normalizes it to its stored form.
 *
 * `frequency` is optional and must be the literal `monthly` or `weekly`;
 * absent, empty or `null` means monthly. Weekly requires a whole ISO weekday
 * 1..7, and a monthly row never keeps a weekday (`0` and absent are equal).
 */
export function resolveRecurrenceCadence(
  frequency: unknown,
  weekday: unknown
): ResolvedRecurrenceCadence {
  if (
    frequency !== undefined &&
    frequency !== null &&
    frequency !== '' &&
    frequency !== 'monthly' &&
    frequency !== 'weekly'
  ) {
    throw new ValidationError('Recurrence frequency must be monthly or weekly.');
  }
  const cadence: RecurrenceCadence = frequency === 'weekly' ? 'weekly' : 'monthly';

  if (weekday !== undefined && weekday !== null && weekday !== '') {
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 7) {
      throw new ValidationError('Recurrence weekday must be a whole number between 1 and 7.');
    }
  }
  const requestedWeekday = typeof weekday === 'number' && weekday >= 1 ? weekday : undefined;

  if (cadence === 'weekly' && requestedWeekday === undefined) {
    throw new ValidationError('A weekly recurrence requires a weekday between 1 and 7.');
  }

  return { frequency: cadence, weekday: cadence === 'weekly' ? requestedWeekday : undefined };
}
