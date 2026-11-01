import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { NotFoundError } from '../../../domain/errors';
import {
  calculateCardDueDate,
  calculateClampedDate,
  dayKey,
  getCurrentMonthBoundaries,
  monthKey
} from '../../../domain/utils/dateUtils';
import {
  recurrenceCadence,
  recurrenceChildKey,
  recurrenceOccurrence,
  recurrencePeriodKey
} from '../../../domain/recurrence/cadence';
import { roundCurrency } from '../../../domain/utils/mathUtils';
import { Transaction } from '../../../domain/entities/Transaction';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

export interface ProcessRecurrencesResult {
  success: boolean;
  processed: number;
  skipped: number;
  generatedNames: string[];
  message: string;
  error?: string;
}

/**
 * Daily cron materialization of the current period.
 *
 * The monthly branch is the historical rule table: clamped `payday` of the
 * current UTC month, `YYYY-MM` keys and `purchase_date`/`expected_date` month
 * idempotency. The weekly branch is the same table over UTC ISO weeks
 * ([D019]): the chosen weekday of the current ISO week, exact dates, and the
 * occurrence day `YYYY-MM-DD` for skip keys and idempotency.
 */
export class ProcessMonthlyRecurrencesUseCase {
  constructor(
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase,
    private readonly cardRepository: CardRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(): Promise<ProcessRecurrencesResult> {
    let processed = 0;
    let skipped = 0;
    const generatedNames: string[] = [];

    const now = new Date(this.clock.now());
    const { year, month, lastDay } = getCurrentMonthBoundaries(now);
    const activeRecurrences = await this.recurrenceRepository.listAll();
    const transactions = await this.transactionRepository.listAll();

    for (const rec of activeRecurrences) {
      if (rec.status !== 'active') continue;

      const cadence = recurrenceCadence(rec);
      const occurrence =
        cadence === 'weekly'
          ? recurrenceOccurrence(rec, now)
          : calculateClampedDate(year, month, rec.payday, lastDay);

      // Expiry compares the occurrence with end_date, not the current instant.
      if (rec.end_date && new Date(occurrence) > new Date(rec.end_date)) {
        await this.recurrenceRepository.update(rec.id, { status: 'ended' });
        skipped += 1;
        continue;
      }

      const period = recurrencePeriodKey(cadence, occurrence);
      const skippedPeriods = rec.skipped_periods || [];
      if (skippedPeriods.includes(period)) {
        skipped += 1;
        continue;
      }

      // The monthly card rule also honors a skipped invoice month. A weekly
      // row is keyed by its occurrence day only (the invoice-level skip keys
      // weekly deletions write are day keys, not month keys).
      if (cadence === 'monthly' && rec.card_id) {
        const card = await this.cardRepository.findById(rec.card_id);
        if (!card) throw new NotFoundError(`Card ${rec.card_id} was not found.`);
        const invoicePeriod = monthKey(
          calculateCardDueDate(occurrence, card.closing_day, card.due_day)
        );
        if (skippedPeriods.includes(invoicePeriod)) {
          skipped += 1;
          continue;
        }
      }

      const existingChildren = transactions.filter(t => t.recurrence_id === rec.id);

      if (
        rec.total_installments &&
        rec.total_installments > 0 &&
        existingChildren.length + 1 > rec.total_installments
      ) {
        await this.recurrenceRepository.update(rec.id, { status: 'ended' });
        skipped += 1;
        continue;
      }

      const launched = existingChildren.some(txn => {
        if (cadence === 'weekly') return recurrenceChildKey(rec, txn) === period;
        const purchaseMonth = txn.purchase_date ? monthKey(txn.purchase_date) : null;
        const expectedMonth = monthKey(txn.expected_date);
        if (rec.card_id) return (purchaseMonth ?? expectedMonth) === period;
        return purchaseMonth === period || expectedMonth === period;
      });
      if (launched) {
        skipped += 1;
        continue;
      }

      const installmentLabel =
        rec.total_installments && rec.total_installments > 0
          ? `Parcela ${existingChildren.length + 1}/${rec.total_installments}`
          : cadence === 'weekly'
            ? dayKey(occurrence)
            : `${month + 1}/${year}`;

      const payload: Partial<Transaction> = {
        title: `${rec.name} - ${installmentLabel}`,
        amount: roundCurrency(rec.amount),
        type: rec.type,
        status: 'pending',
        expected_date: occurrence,
        purchase_date: occurrence,
        is_recurring: true,
        recurrence_id: rec.id,
        account_id: rec.account_id || undefined,
        card_id: rec.card_id || undefined,
        category_id: rec.category_id || undefined
      };

      if (rec.card_id) {
        const invoice = await this.syncInvoiceUseCase.execute(
          rec.card_id,
          occurrence,
          rec.amount,
          rec.type
        );
        payload.invoice_id = invoice.id;
        payload.expected_date = invoice.due_date;
      }

      await this.transactionRepository.create(payload);
      processed += 1;
      generatedNames.push(rec.name);
    }

    return {
      success: true,
      processed,
      skipped,
      generatedNames,
      message: 'Recurrence engine completed.'
    };
  }
}
