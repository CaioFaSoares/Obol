import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { Account } from '../../../domain/entities/Account';
import { NotFoundError } from '../../../domain/errors';
import { dayKey } from '../../../domain/utils/dateUtils';
import { recurrenceCadence } from '../../../domain/recurrence/cadence';
import { roundCurrency, sum, sub } from '../../../domain/utils/mathUtils';

export interface DeleteInvoiceResult {
  success: boolean;
  message: string;
  transactionsDeleted: number;
  recurrencesSkipped: string[];
}

export class DeleteInvoiceUseCase {
  constructor(
    private readonly invoiceRepository: InvoiceRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly accountRepository: AccountRepository
  ) {}

  async execute(cardId: string, period: string): Promise<DeleteInvoiceResult> {
    const invoice = await this.invoiceRepository.findByPeriodAndCard(cardId, period);
    if (!invoice) {
      throw new NotFoundError(`Invoice for period ${period} was not found.`);
    }

    const allTransactions = await this.transactionRepository.listAll();
    const childTxns = allTransactions.filter(t => t.invoice_id === invoice.id);

    // Resolve every referenced recurrence before writing, then record the
    // deleted period so the cron cannot regenerate it. A weekly recurrence is
    // keyed per child day, so each occurrence deleted from the invoice gets its
    // own day key instead of the invoice month.
    const skippedRecurrences: string[] = [];
    const recurrences = new Map<
      string,
      { id: string; name: string; weekly: boolean; skipped: Set<string> }
    >();
    for (const txn of childTxns) {
      if (!txn.recurrence_id) continue;
      let entry = recurrences.get(txn.recurrence_id);
      if (!entry) {
        const rec = await this.recurrenceRepository.findById(txn.recurrence_id);
        if (!rec) throw new NotFoundError(`Recurrence ${txn.recurrence_id} was not found.`);
        entry = {
          id: rec.id,
          name: rec.name,
          weekly: recurrenceCadence(rec) === 'weekly',
          skipped: new Set(rec.skipped_periods || [])
        };
        recurrences.set(rec.id, entry);
      }
      if (entry.weekly) {
        const referenceDate = txn.purchase_date || txn.expected_date;
        if (referenceDate) entry.skipped.add(dayKey(referenceDate));
      } else {
        entry.skipped.add(invoice.period);
      }
    }

    for (const rec of recurrences.values()) {
      await this.recurrenceRepository.update(rec.id, {
        skipped_periods: Array.from(rec.skipped).sort()
      });
      skippedRecurrences.push(rec.name);
    }

    // Deleting the invoice removes its children and their real cash effects.
    // Resolve every referenced account before the first write.
    const accountCache = new Map<string, Account>();
    for (const txn of childTxns) {
      if (txn.status !== 'realized' || txn.is_silent === true || txn.is_simulated === true) continue;
      for (const accountId of [txn.account_id, txn.destination_account_id]) {
        if (!accountId || accountCache.has(accountId)) continue;
        const account = await this.accountRepository.findById(accountId);
        if (!account) throw new NotFoundError(`Account ${accountId} was not found.`);
        accountCache.set(accountId, account);
      }
    }

    for (const txn of childTxns) {
      const amount = roundCurrency(txn.amount);
      if (txn.status === 'realized' && txn.is_silent !== true && txn.is_simulated !== true) {
        if (txn.type === 'transfer' && txn.account_id && txn.destination_account_id) {
          const source = accountCache.get(txn.account_id) as Account;
          const destination = accountCache.get(txn.destination_account_id) as Account;
          await this.accountRepository.update(source.id, {
            initial_balance: sum(source.initial_balance, amount)
          });
          await this.accountRepository.update(destination.id, {
            initial_balance: sub(destination.initial_balance, amount)
          });
        } else if (txn.account_id && txn.type !== 'transfer') {
          const account = accountCache.get(txn.account_id) as Account;
          const revertDelta = txn.type === 'income' ? -amount : amount;
          await this.accountRepository.update(account.id, {
            initial_balance: sum(account.initial_balance, revertDelta)
          });
        }
      }
      await this.transactionRepository.delete(txn.id);
    }

    await this.invoiceRepository.delete(invoice.id);

    return {
      success: true,
      message: `Invoice ${period} was deleted.`,
      transactionsDeleted: childTxns.length,
      recurrencesSkipped: skippedRecurrences
    };
  }
}
