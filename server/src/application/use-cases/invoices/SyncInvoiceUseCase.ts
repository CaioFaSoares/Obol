import { Invoice } from '../../../domain/entities/Invoice';
import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { calculateCardDueDate } from '../../../domain/utils/dateUtils';
import { sum } from '../../../domain/utils/mathUtils';

export class SyncInvoiceUseCase {
  constructor(
    private readonly cardRepository: CardRepository,
    private readonly invoiceRepository: InvoiceRepository
  ) {}

  async execute(cardId: string, expectedDate: string, amount: number, type: string): Promise<Invoice> {
    // 1. Busca regras do cartão e calcula o vencimento
    const card = await this.cardRepository.findById(cardId);
    const projectedDueDate = calculateCardDueDate(expectedDate, card.closing_day, card.due_day);
    const period = projectedDueDate.substring(0, 7); // Ex: "2026-05"

    // 2. Busca se a fatura já existe
    let invoice = await this.invoiceRepository.findByPeriodAndCard(cardId, period);

    // 3. Calcula o impacto no saldo (Despesa soma, Receita subtrai)
    const amountDelta = type === 'expense' ? amount : -amount;

    if (invoice) {
      // 4a. Atualiza a fatura existente
      const newTotal = sum(invoice.total_amount, amountDelta);
      return await this.invoiceRepository.update(invoice.id, {
        total_amount: newTotal
      });
    } else {
      // 4b. Cria uma nova fatura
      return await this.invoiceRepository.create({
        card_id: cardId,
        period,
        due_date: projectedDueDate,
        status: 'OPEN',
        total_amount: amountDelta,
        paid_amount: 0
      });
    }
  }
}
