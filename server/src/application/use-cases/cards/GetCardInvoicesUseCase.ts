import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { Card } from '../../../domain/entities/Card';
import { Recurrence } from '../../../domain/entities/Recurrence';
import { Transaction } from '../../../domain/entities/Transaction';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import {
  addMonthsToPeriod,
  addUtcDays,
  calculateCardDueDate,
  calculateClampedDate,
  dayKey,
  daysInUtcMonth,
  isoWeekOccurrence,
  monthKey,
  startOfIsoWeek
} from '../../../domain/utils/dateUtils';
import {
  recurrenceCadence,
  recurrenceChildKey,
  recurrencePeriodKey
} from '../../../domain/recurrence/cadence';
import { roundCurrency, sum, sub } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

export interface GetCardInvoicesResponse {
  period: string;
  dueDate: string;
  totalAmount: number;
  paidAmount: number;
  totalSpent: number;
  status: 'OPEN' | 'CLOSED' | 'PAID' | 'PROJECTED';
  transactions: {
    id: string;
    title: string;
    amount: number;
    status: string;
    expected_date: string;
    purchase_date: string | null;
    recurrence_id: string | null;
  }[];
}

export class GetCardInvoicesUseCase {
  constructor(
    private readonly cardRepository: CardRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(cardId: string): Promise<GetCardInvoicesResponse[]> {
    const card = await this.cardRepository.findById(cardId);
    if (!card) {
      throw new NotFoundError('Card was not found.');
    }

    const allTransactions = await this.transactionRepository.listAll();
    const allRecurrences = await this.recurrenceRepository.listAll();
    const activeCardRecurrences = allRecurrences.filter(
      rec => rec.status === 'active' && rec.card_id === card.id
    );

    // Installment plans count generated children first, then the lines this
    // projection adds across the whole timeline, so four weekly occurrences in
    // one invoice cannot all claim the last slot.
    const childCounts = new Map<string, number>();
    for (const rec of activeCardRecurrences) {
      childCounts.set(rec.id, allTransactions.filter(t => t.recurrence_id === rec.id).length);
    }
    const projectedCounts = new Map<string, number>();

    const physicalInvoices = (await this.invoiceRepository.listAll())
      .filter(inv => inv.card_id === card.id)
      .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));

    const result: GetCardInvoicesResponse[] = [];

    for (const invoice of physicalInvoices) {
      const children = allTransactions
        .filter(t => t.invoice_id === invoice.id)
        .sort((a, b) => (a.expected_date < b.expected_date ? -1 : a.expected_date > b.expected_date ? 1 : 0));

      let totalSpent = 0;
      for (const txn of children) {
        if (txn.type === 'expense') totalSpent = sum(totalSpent, txn.amount);
        if (txn.type === 'income') totalSpent = sub(totalSpent, txn.amount);
      }

      const lines: GetCardInvoicesResponse['transactions'] = children.map(txn => ({
        id: txn.id,
        title: txn.title,
        amount: txn.amount,
        status: txn.status,
        expected_date: txn.expected_date,
        purchase_date: txn.purchase_date || null,
        recurrence_id: txn.recurrence_id || null
      }));

      let projectedDelta = 0;
      if (invoice.status === 'OPEN') {
        for (const rec of activeCardRecurrences) {
          const cadence = recurrenceCadence(rec);
          // A monthly rule projects only when the invoice has no child of that
          // recurrence. A weekly rule projects every occurrence the invoice
          // covers, so a single real child never hides the remaining weeks.
          if (cadence === 'monthly' && children.some(t => t.recurrence_id === rec.id)) continue;

          const occurrences = this.occurrencesForInvoicePeriod(rec, card, invoice.period);
          for (const occurrence of occurrences) {
            if (!this.isProjectable(rec, occurrence, invoice.period, allTransactions)) continue;
            if (!this.hasProjectionSlot(rec, childCounts, projectedCounts)) continue;

            const delta = rec.type === 'expense' ? roundCurrency(rec.amount) : -roundCurrency(rec.amount);
            projectedDelta = sum(projectedDelta, delta);

            lines.push({
              id: this.projectedLineId(rec, occurrence, invoice.period),
              title: this.projectedTitle(rec, occurrence, childCounts, projectedCounts),
              amount: roundCurrency(rec.amount),
              status: 'projected',
              expected_date: occurrence,
              purchase_date: null,
              recurrence_id: rec.id
            });
            projectedCounts.set(rec.id, (projectedCounts.get(rec.id) ?? 0) + 1);
          }
        }
        lines.sort((a, b) => {
          if (a.expected_date !== b.expected_date) return a.expected_date < b.expected_date ? -1 : 1;
          return (a.recurrence_id || '') < (b.recurrence_id || '') ? -1 : 1;
        });
      }

      result.push({
        period: invoice.period,
        dueDate: invoice.due_date,
        totalAmount: sum(sub(invoice.total_amount, invoice.paid_amount ?? 0), projectedDelta),
        paidAmount: invoice.paid_amount ?? 0,
        totalSpent: sum(totalSpent, projectedDelta),
        status: invoice.status,
        transactions: lines
      });
    }

    // One virtual invoice for the next period, containing only projected
    // recurrence lines. It never has a stored id or paid amount.
    const currentPeriod = monthKey(this.clock.now());
    const latestPeriod = physicalInvoices.length > 0 ? physicalInvoices[0].period : currentPeriod;
    const nextPeriod = latestPeriod < currentPeriod ? currentPeriod : addMonthsToPeriod(latestPeriod, 1);

    if (!physicalInvoices.some(inv => inv.period === nextPeriod)) {
      const projectedLines: GetCardInvoicesResponse['transactions'] = [];
      let projectedTotal = 0;
      let projectedDueDate: string | null = null;

      for (const rec of activeCardRecurrences) {
        const occurrences = this.occurrencesForInvoicePeriod(rec, card, nextPeriod);
        for (const occurrence of occurrences) {
          if (!this.isProjectable(rec, occurrence, nextPeriod, allTransactions)) continue;
          if (!this.hasProjectionSlot(rec, childCounts, projectedCounts)) continue;

          const delta = rec.type === 'expense' ? roundCurrency(rec.amount) : -roundCurrency(rec.amount);
          projectedTotal = sum(projectedTotal, delta);
          projectedDueDate ??= calculateCardDueDate(occurrence, card.closing_day, card.due_day);

          projectedLines.push({
            id: this.virtualProjectedLineId(rec, occurrence),
            title: this.projectedTitle(rec, occurrence, childCounts, projectedCounts),
            amount: roundCurrency(rec.amount),
            status: 'projected',
            expected_date: occurrence,
            purchase_date: null,
            recurrence_id: rec.id
          });
          projectedCounts.set(rec.id, (projectedCounts.get(rec.id) ?? 0) + 1);
        }
      }

      if (projectedLines.length > 0 && projectedDueDate) {
        projectedLines.sort((a, b) => {
          if (a.expected_date !== b.expected_date) return a.expected_date < b.expected_date ? -1 : 1;
          return (a.recurrence_id || '') < (b.recurrence_id || '') ? -1 : 1;
        });
        result.unshift({
          period: nextPeriod,
          dueDate: projectedDueDate,
          totalAmount: projectedTotal,
          paidAmount: 0,
          totalSpent: projectedTotal,
          status: 'PROJECTED',
          transactions: projectedLines
        });
      }
    }

    return result;
  }

  /**
   * Every occurrence of `rec` whose card due date falls in `period`, oldest
   * first.
   *
   * A monthly rule has at most one: its clamped occurrence can land in the
   * current, previous or two-months-earlier month depending on the closing and
   * due days, so those three months are checked. A weekly rule has one
   * occurrence per ISO week, so up to five land in one invoice.
   */
  private occurrencesForInvoicePeriod(rec: Recurrence, card: Card, period: string): string[] {
    if (recurrenceCadence(rec) === 'weekly') {
      const weekday = rec.weekday;
      if (!Number.isInteger(weekday) || (weekday as number) < 1 || (weekday as number) > 7) {
        throw new ValidationError(`Recurrence ${rec.id} has no valid weekday for its weekly cadence.`);
      }
      const [year, month] = period.split('-').map(Number);
      const firstDay = new Date(Date.UTC(year, month - 3, 1));
      const lastDay = new Date(Date.UTC(year, month - 1, daysInUtcMonth(year, month - 1)));
      const occurrences: string[] = [];
      let cursor = startOfIsoWeek(firstDay);
      while (cursor <= lastDay) {
        const occurrence = isoWeekOccurrence(cursor, weekday as number);
        const duePeriod = monthKey(calculateCardDueDate(occurrence, card.closing_day, card.due_day));
        if (duePeriod === period) occurrences.push(occurrence);
        cursor = addUtcDays(cursor, 7);
      }
      return occurrences;
    }

    const [year, month] = period.split('-').map(Number);
    for (let offset = 0; offset <= 2; offset += 1) {
      const cursor = new Date(Date.UTC(year, month - 1 - offset, 1));
      const cursorYear = cursor.getUTCFullYear();
      const cursorMonth = cursor.getUTCMonth();
      const occurrence = calculateClampedDate(
        cursorYear,
        cursorMonth,
        rec.payday,
        daysInUtcMonth(cursorYear, cursorMonth)
      );
      const dueDate = calculateCardDueDate(occurrence, card.closing_day, card.due_day);
      if (dueDate.substring(0, 7) === period) return [occurrence];
    }
    return [];
  }

  /** End date, manual skips, and finite installment limits. */
  private isProjectable(
    rec: Recurrence,
    occurrence: string,
    invoicePeriod: string,
    allTransactions: Transaction[]
  ): boolean {
    if (rec.end_date && new Date(occurrence) > new Date(rec.end_date)) return false;

    const cadence = recurrenceCadence(rec);
    const skipped = rec.skipped_periods || [];
    if (cadence === 'weekly') {
      if (skipped.includes(dayKey(occurrence))) return false;
    } else if (skipped.includes(monthKey(occurrence)) || skipped.includes(invoicePeriod)) {
      return false;
    }

    const periodKey = recurrencePeriodKey(cadence, occurrence);
    const launched = allTransactions.some(txn => {
      if (txn.recurrence_id !== rec.id) return false;
      return recurrenceChildKey(rec, txn) === periodKey;
    });
    if (launched) return false;

    return true;
  }

  /** A finite plan only projects its remaining installments. */
  private hasProjectionSlot(
    rec: Recurrence,
    childCounts: ReadonlyMap<string, number>,
    projectedCounts: ReadonlyMap<string, number>
  ): boolean {
    if (!rec.total_installments || rec.total_installments <= 0) return true;
    const taken = (childCounts.get(rec.id) ?? 0) + (projectedCounts.get(rec.id) ?? 0);
    return taken + 1 <= rec.total_installments;
  }

  /**
   * Existing installment label, preserved for the invoice UI. Weekly lines are
   * numbered by their 0-based position inside the invoice period.
   */
  private projectedTitle(
    rec: Recurrence,
    occurrence: string,
    childCounts: ReadonlyMap<string, number>,
    projectedCounts: ReadonlyMap<string, number>
  ): string {
    const weekly = recurrenceCadence(rec) === 'weekly';
    if (!rec.total_installments || rec.total_installments <= 0) {
      return weekly ? `${rec.name} - ${dayKey(occurrence)}` : rec.name;
    }
    const installment =
      (childCounts.get(rec.id) ?? 0) + (projectedCounts.get(rec.id) ?? 0) + 1;
    return `${rec.name} - Parcela ${installment}/${rec.total_installments}`;
  }

  /** One projected line id per occurrence; monthly keeps its period-only id. */
  private projectedLineId(rec: Recurrence, occurrence: string, invoicePeriod: string): string {
    if (recurrenceCadence(rec) === 'weekly') {
      return `projected-${rec.id}-${dayKey(occurrence)}`;
    }
    return `projected-${rec.id}-${invoicePeriod}`;
  }

  /** The virtual invoice has no stored period, so monthly keeps its bare id. */
  private virtualProjectedLineId(rec: Recurrence, occurrence: string): string {
    if (recurrenceCadence(rec) === 'weekly') {
      return `projected-${rec.id}-${dayKey(occurrence)}`;
    }
    return `projected-${rec.id}`;
  }
}
