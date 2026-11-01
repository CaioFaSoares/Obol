import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { Invoice } from '../../../domain/entities/Invoice';
import { Recurrence } from '../../../domain/entities/Recurrence';
import { NotFoundError } from '../../../domain/errors';
import { dayKey } from '../../../domain/utils/dateUtils';
import { recurrenceCadence } from '../../../domain/recurrence/cadence';
import { roundCurrency, sum, sub } from '../../../domain/utils/mathUtils';

export class DeleteTransactionUseCase {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly accountRepository: AccountRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly recurrenceRepository: RecurrenceRepository
  ) {}

  async execute(id: string): Promise<{ success: boolean }> {
    const oldTxn = await this.transactionRepository.findById(id);
    if (!oldTxn) {
      throw new NotFoundError('Transaction was not found.');
    }

    // Resolve every referenced record before mutating anything. A missing
    // invoice or recurrence must surface, never be swallowed.
    let invoice: Invoice | null = null;
    if (oldTxn.invoice_id && oldTxn.is_simulated !== true) {
      invoice = await this.invoiceRepository.findById(oldTxn.invoice_id);
      if (!invoice) throw new NotFoundError(`Invoice ${oldTxn.invoice_id} was not found.`);
    }

    let recurrence: Recurrence | null = null;
    if (oldTxn.recurrence_id) {
      recurrence = await this.recurrenceRepository.findById(oldTxn.recurrence_id);
      if (!recurrence) throw new NotFoundError(`Recurrence ${oldTxn.recurrence_id} was not found.`);
    }

    const amount = roundCurrency(oldTxn.amount);

    if (oldTxn.status === 'realized' && oldTxn.is_silent !== true && oldTxn.is_simulated !== true) {
      if (oldTxn.type === 'transfer' && oldTxn.account_id && oldTxn.destination_account_id) {
        const source = await this.accountRepository.findById(oldTxn.account_id);
        const destination = await this.accountRepository.findById(oldTxn.destination_account_id);
        if (!source) throw new NotFoundError(`Account ${oldTxn.account_id} was not found.`);
        if (!destination) throw new NotFoundError(`Account ${oldTxn.destination_account_id} was not found.`);
        await this.accountRepository.update(source.id, {
          initial_balance: sum(source.initial_balance, amount)
        });
        await this.accountRepository.update(destination.id, {
          initial_balance: sub(destination.initial_balance, amount)
        });
      } else if (oldTxn.account_id && oldTxn.type !== 'transfer') {
        const account = await this.accountRepository.findById(oldTxn.account_id);
        if (!account) throw new NotFoundError(`Account ${oldTxn.account_id} was not found.`);
        const revertDelta = oldTxn.type === 'income' ? -amount : amount;
        await this.accountRepository.update(account.id, {
          initial_balance: sum(account.initial_balance, revertDelta)
        });
      }
    }

    if (invoice) {
      const amountDelta = oldTxn.type === 'expense' ? -amount : amount;
      await this.invoiceRepository.update(invoice.id, {
        total_amount: sum(invoice.total_amount, amountDelta)
      });
    }

    if (recurrence) {
      const periods = new Set<string>(recurrence.skipped_periods || []);
      const weekly = recurrenceCadence(recurrence) === 'weekly';
      const referenceDate = oldTxn.purchase_date || oldTxn.expected_date;
      if (referenceDate) {
        // Weekly rows skip their occurrence day; monthly rows keep the month.
        periods.add(weekly ? dayKey(referenceDate) : referenceDate.substring(0, 7));
      }
      // The invoice month is a monthly skip key; a weekly row is keyed by day.
      if (invoice && !weekly) periods.add(invoice.period);
      await this.recurrenceRepository.update(recurrence.id, {
        skipped_periods: Array.from(periods).sort()
      });
    }

    await this.transactionRepository.delete(id);
    return { success: true };
  }
}
