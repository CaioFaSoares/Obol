import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { NotFoundError } from '../../../domain/errors';

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
    private readonly recurrenceRepository: RecurrenceRepository
  ) {}

  async execute(cardId: string, period: string): Promise<DeleteInvoiceResult> {
    // 1. Busca a fatura pelo card_id + period
    const invoice = await this.invoiceRepository.findByPeriodAndCard(cardId, period);
    if (!invoice) {
      throw new NotFoundError(`Fatura não encontrada para o período ${period}.`);
    }

    // 2. Busca todas as transações filhas dessa fatura
    const childTxns = await this.transactionRepository.listAll({
      filter: `invoice_id = '${invoice.id}'`
    });

    // 3. Para cada transação recorrente, registra o skip na recorrência pai
    const skippedRecurrences: string[] = [];
    for (const txn of childTxns) {
      if (txn.recurrence_id) {
        try {
          const rec = await this.recurrenceRepository.findById(txn.recurrence_id);
          let skipped = rec.skipped_periods || [];
          if (!skipped.includes(invoice.period)) {
            skipped.push(invoice.period);
            await this.recurrenceRepository.update(rec.id, { skipped_periods: skipped });
            skippedRecurrences.push(rec.name);
          }
        } catch (e) {
          // Recorrência pode ter sido deletada
        }
      }
    }

    // 4. Deleta todas as transações filhas
    for (const txn of childTxns) {
      await this.transactionRepository.delete(txn.id);
    }

    // 5. Deleta a fatura
    await this.invoiceRepository.delete(invoice.id);

    return {
      success: true,
      message: `Fatura ${period} excluída com segurança.`,
      transactionsDeleted: childTxns.length,
      recurrencesSkipped: skippedRecurrences
    };
  }
}
