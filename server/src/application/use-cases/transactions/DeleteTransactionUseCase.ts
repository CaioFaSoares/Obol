import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { NotFoundError } from '../../../domain/errors';
import { sum, sub } from '../../../domain/utils/mathUtils';

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
      throw new NotFoundError('Transação não encontrada');
    }

    if (oldTxn.account_id && oldTxn.status === 'realized') {
      if (oldTxn.type === 'transfer' && oldTxn.destination_account_id) {
        const sourceAcc = await this.accountRepository.findById(oldTxn.account_id);
        const destAcc = await this.accountRepository.findById(oldTxn.destination_account_id);
        await this.accountRepository.update(sourceAcc.id, { initial_balance: sum(sourceAcc.initial_balance, oldTxn.amount) });
        await this.accountRepository.update(destAcc.id, { initial_balance: sub(destAcc.initial_balance, oldTxn.amount) });
      } else {
        const account = await this.accountRepository.findById(oldTxn.account_id);
        let revertedBalance = account.initial_balance;
        
        if (oldTxn.type === 'income') revertedBalance = sub(revertedBalance, oldTxn.amount);
        if (oldTxn.type === 'expense') revertedBalance = sum(revertedBalance, oldTxn.amount);

        await this.accountRepository.update(oldTxn.account_id, { 
          initial_balance: revertedBalance 
        });
      }
    }

    // REGRA DE FATURAS FÍSICAS: Estornar do total_amount da fatura pai
    if (oldTxn.card_id && oldTxn.invoice_id) {
      try {
        const invoice = await this.invoiceRepository.findById(oldTxn.invoice_id);
        const amountDelta = oldTxn.type === 'expense' ? -oldTxn.amount : oldTxn.amount;
        await this.invoiceRepository.update(invoice.id, {
          total_amount: sum(invoice.total_amount, amountDelta)
        });

        if (oldTxn.recurrence_id) {
          const rec = await this.recurrenceRepository.findById(oldTxn.recurrence_id);
          let skipped = rec.skipped_periods || [];
          const pDate = oldTxn.purchase_date || oldTxn.expected_date;
          const purchasePeriod = pDate.substring(0, 7);
          if (!skipped.includes(purchasePeriod)) skipped.push(purchasePeriod);
          if (!skipped.includes(invoice.period)) skipped.push(invoice.period);
          await this.recurrenceRepository.update(rec.id, { skipped_periods: skipped });
        }
      } catch (e) {
        console.error("Fatura ou Recorrência não encontrada para estorno:", e);
      }
    } else if (oldTxn.recurrence_id) {
      try {
        const rec = await this.recurrenceRepository.findById(oldTxn.recurrence_id);
        let skipped = rec.skipped_periods || [];
        const pDate = oldTxn.purchase_date || oldTxn.expected_date;
        const purchasePeriod = pDate.substring(0, 7);
        if (!skipped.includes(purchasePeriod)) {
          skipped.push(purchasePeriod);
          await this.recurrenceRepository.update(rec.id, { skipped_periods: skipped });
        }
      } catch (e) {
        console.error("Recorrência não encontrada para estorno:", e);
      }
    }

    await this.transactionRepository.delete(id);
    return { success: true };
  }
}
