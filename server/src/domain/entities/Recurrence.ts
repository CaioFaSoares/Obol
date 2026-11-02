export interface Recurrence {
  id: string;
  name: string;
  amount: number;
  payday: number;
  type: 'income' | 'expense';
  status: 'active' | 'paused' | 'ended';
  /** Cadence. Absent reads as `monthly`, the only cadence before 0.4.5. */
  frequency?: 'monthly' | 'weekly';
  /** ISO weekday 1..7 (Monday = 1). Required for weekly, absent otherwise. */
  weekday?: number;
  account_id?: string;
  card_id?: string;
  category_id?: string;
  end_date?: string;
  total_installments?: number;
  skipped_periods?: string[];
  created?: string;
  updated?: string;
}

/**
 * Client-editable recurrence fields.
 *
 * An omitted field keeps its stored value; `null` clears a canonical optional
 * relation or date. `status` is owned by the toggle, launch and expiry paths,
 * so an update can never resurrect an ended recurrence.
 */
export interface RecurrenceUpdatePatch {
  readonly name?: string;
  readonly amount?: number;
  readonly payday?: number;
  readonly type?: 'income' | 'expense';
  /** Cadence patch; `null` clears back to monthly. */
  readonly frequency?: 'monthly' | 'weekly' | null;
  /** ISO weekday patch; `null` clears it (valid only when the final cadence is monthly). */
  readonly weekday?: number | null;
  readonly account_id?: string | null;
  readonly card_id?: string | null;
  readonly category_id?: string | null;
  readonly end_date?: string | null;
  readonly total_installments?: number | null;
  readonly skipped_periods?: readonly string[];
}

/**
 * Full write body for the recurrence storage record.
 *
 * PocketBase stores the empty string for an unset relation or date and `0` for
 * an unset number, so clears are written with those blank values and the
 * stored entity keeps its undefined-based shape. A weekly recurrence requires
 * its ISO weekday; a monthly row stores the blank `0`.
 */
export function storedRecurrenceFields(recurrence: Recurrence): Partial<Recurrence> {
  return {
    name: recurrence.name,
    amount: recurrence.amount,
    payday: recurrence.payday,
    type: recurrence.type,
    status: recurrence.status,
    frequency: recurrence.frequency ?? 'monthly',
    weekday: recurrence.weekday ?? 0,
    account_id: recurrence.account_id ?? '',
    card_id: recurrence.card_id ?? '',
    category_id: recurrence.category_id ?? '',
    end_date: recurrence.end_date ?? '',
    total_installments: recurrence.total_installments ?? 0,
    skipped_periods: recurrence.skipped_periods ?? []
  };
}
