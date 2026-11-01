import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { NotFoundError, ConflictError, ValidationError } from '../../../domain/errors';
import { Transaction } from '../../../domain/entities/Transaction';
import {
  addUtcMonths,
  calculateClampedDate,
  dayKey,
  daysInUtcMonth,
  monthKey,
  startOfUtcMonth
} from '../../../domain/utils/dateUtils';
import {
  nextRecurrenceOccurrence,
  recurrenceCadence,
  recurrenceChildKey,
  recurrenceOccurrence,
  recurrencePeriodKey
} from '../../../domain/recurrence/cadence';
import { roundCurrency } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

export class LaunchRecurrenceUseCase {
  constructor(
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  /**
   * Launches the next pending occurrence.
   *
   * `targetPeriod` (`YYYY-MM` monthly, `YYYY-MM-DD` weekly) lets a replayed
   * offline launch keep the period the user launched, independent of the
   * reconnect wall clock. When omitted the historical behavior applies: the
   * month after `clock.now()` for monthly rows, the occurrence of the next UTC
   * ISO week for weekly rows.
   */
  async execute(id: string, targetPeriod?: string): Promise<Transaction> {
    const recurrence = await this.recurrenceRepository.findById(id);
    if (!recurrence) {
      throw new NotFoundError('Recurrence was not found.');
    }
    if (recurrence.status === 'ended') {
      throw new ValidationError('A recurrence that has ended cannot be launched.');
    }

    const cadence = recurrenceCadence(recurrence);
    let expectedDate: string;

    if (cadence === 'weekly') {
      if (targetPeriod !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(targetPeriod)) {
          throw new ValidationError('The launch target day must be a YYYY-MM-DD value.');
        }
        const occurrence = recurrenceOccurrence(recurrence, targetPeriod);
        if (dayKey(occurrence) !== targetPeriod) {
          throw new ValidationError('The launch target day must be the recurrence weekday occurrence.');
        }
        expectedDate = occurrence;
      } else {
        // Manual launch targets the next ISO week's occurrence.
        expectedDate = nextRecurrenceOccurrence(recurrence, this.clock.now());
      }
    } else {
      let year: number;
      let month: number;
      if (targetPeriod !== undefined) {
        const match = /^(\d{4})-(\d{2})$/.exec(targetPeriod);
        if (!match) {
          throw new ValidationError('The launch target month must be a YYYY-MM value.');
        }
        year = Number(match[1]);
        month = Number(match[2]) - 1;
        if (month < 0 || month > 11) {
          throw new ValidationError('The launch target month must be a YYYY-MM value.');
        }
      } else {
        // Manual launch targets the month after the current one.
        const target = addUtcMonths(startOfUtcMonth(this.clock.now()), 1);
        year = target.getUTCFullYear();
        month = target.getUTCMonth();
      }
      const lastDay = daysInUtcMonth(year, month);
      expectedDate = calculateClampedDate(year, month, recurrence.payday, lastDay);
    }

    if (recurrence.end_date && new Date(expectedDate) > new Date(recurrence.end_date)) {
      throw new ValidationError('The occurrence falls after the recurrence end date.');
    }

    const period = recurrencePeriodKey(cadence, expectedDate);
    const transactions = await this.transactionRepository.listAll();
    const existingChildren = transactions.filter(t => t.recurrence_id === recurrence.id);

    if (
      recurrence.total_installments &&
      recurrence.total_installments > 0 &&
      existingChildren.length + 1 > recurrence.total_installments
    ) {
      await this.recurrenceRepository.update(recurrence.id, { status: 'ended' });
      throw new ValidationError('The installment plan is already complete.');
    }

    const launched = existingChildren.some(txn => {
      if (cadence === 'weekly') return recurrenceChildKey(recurrence, txn) === period;
      const purchaseMonth = txn.purchase_date ? monthKey(txn.purchase_date) : null;
      const expectedMonth = monthKey(txn.expected_date);
      if (recurrence.card_id) return (purchaseMonth ?? expectedMonth) === period;
      return purchaseMonth === period || expectedMonth === period;
    });
    if (launched) {
      throw new ConflictError(`A transaction already exists for ${period}.`);
    }

    const installmentLabel =
      recurrence.total_installments && recurrence.total_installments > 0
        ? `Parcela ${existingChildren.length + 1}/${recurrence.total_installments}`
        : cadence === 'weekly'
          ? period
          : `${Number(period.slice(5, 7))}/${period.slice(0, 4)}`;

    const payload: Partial<Transaction> = {
      title: `${recurrence.name} - ${installmentLabel}`,
      amount: roundCurrency(recurrence.amount),
      type: recurrence.type,
      status: 'pending',
      expected_date: expectedDate,
      purchase_date: expectedDate,
      is_recurring: true,
      account_id: recurrence.account_id || undefined,
      card_id: recurrence.card_id || undefined,
      category_id: recurrence.category_id || undefined,
      recurrence_id: recurrence.id
    };

    if (recurrence.card_id) {
      const invoice = await this.syncInvoiceUseCase.execute(
        recurrence.card_id,
        expectedDate,
        recurrence.amount,
        recurrence.type
      );
      payload.invoice_id = invoice.id;
      payload.expected_date = invoice.due_date;
    }

    return await this.transactionRepository.create(payload);
  }
}
