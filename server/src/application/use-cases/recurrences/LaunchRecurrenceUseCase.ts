import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { NotFoundError, ConflictError, ValidationError } from '../../../domain/errors';
import { Transaction } from '../../../domain/entities/Transaction';

export class LaunchRecurrenceUseCase {
  constructor(
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase
  ) {}

  async execute(id: string): Promise<Transaction> {
    const recurrence = await this.recurrenceRepository.findById(id);
    if (!recurrence) {
      throw new NotFoundError('Recorrência não encontrada.');
    }
    
    // Calcular a data para o PRÓXIMO mês (não o atual)
    const now = new Date();
    let nextMonth = now.getMonth() + 1; // 0-indexed, +1 = próximo
    let nextYear = now.getFullYear();
    if (nextMonth > 11) {
      nextMonth = 0;
      nextYear++;
    }
    
    // Clamping: se payday=31 e o próximo mês tem 28 dias, usa o último dia
    const lastDayOfNextMonth = new Date(nextYear, nextMonth + 1, 0).getDate();
    const clampedDay = Math.min(recurrence.payday, lastDayOfNextMonth);
    const expectedDate = new Date(nextYear, nextMonth, clampedDay).toISOString();

    // Título com label de parcela se aplicável
    const monthLabel = `${nextMonth + 1}/${nextYear}`;
    let title = `${recurrence.name} - ${monthLabel}`;

    if (recurrence.total_installments && recurrence.total_installments > 0) {
      const history = await this.transactionRepository.list({
        page: 1,
        perPage: 1,
        filter: `recurrence_id = '${recurrence.id}'`
      });
      const nextInstallment = history.totalItems + 1;
      if (nextInstallment > recurrence.total_installments) {
        await this.recurrenceRepository.update(recurrence.id, { status: 'ended' });
        throw new ValidationError('Parcelamento já concluído. Contrato encerrado.');
      }
      title = `${recurrence.name} - Parcela ${nextInstallment}/${recurrence.total_installments}`;
    }

    // Verifica idempotência: já existe transação para o próximo mês?
    const startOfNext = new Date(nextYear, nextMonth, 1).toISOString();
    const endOfNext = new Date(nextYear, nextMonth + 1, 0, 23, 59, 59).toISOString();
    const existing = await this.transactionRepository.listAll({
      filter: `recurrence_id = '${recurrence.id}' && expected_date >= '${startOfNext}' && expected_date <= '${endOfNext}'`
    });
    if (existing.length > 0) {
      throw new ConflictError('Já existe um lançamento para o próximo mês.');
    }

    const txnPayload: Partial<Transaction> = {
      title,
      amount: recurrence.amount,
      type: recurrence.type,
      status: 'pending',
      expected_date: expectedDate,
      purchase_date: expectedDate,
      is_recurring: true,
      account_id: recurrence.account_id || undefined,
      card_id: recurrence.card_id || undefined,
      recurrence_id: recurrence.id
    };

    // Sincroniza com fatura física se for cartão de crédito
    if (recurrence.card_id) {
      const invoice = await this.syncInvoiceUseCase.execute(
        recurrence.card_id,
        expectedDate,
        recurrence.amount,
        recurrence.type
      );
      txnPayload.invoice_id = invoice.id;
      txnPayload.expected_date = invoice.due_date;
    }

    return await this.transactionRepository.create(txnPayload);
  }
}
