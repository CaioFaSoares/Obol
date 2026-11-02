import { Invoice } from '../../../domain/entities/Invoice';
import { Card } from '../../../domain/entities/Card';
import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { calculateCardDueDate } from '../../../domain/utils/dateUtils';
import { roundCurrency, sum } from '../../../domain/utils/mathUtils';

export class SyncInvoiceUseCase {
  constructor(
    private readonly cardRepository: CardRepository,
    private readonly invoiceRepository: InvoiceRepository
  ) {}

  async execute(cardId: string, expectedDate: string, amount: number, type: string): Promise<Invoice> {
    if (type !== 'expense' && type !== 'income') {
      throw new ValidationError('An invoice can only be charged an income or an expense.');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError('Invoice amount must be greater than zero.');
    }

    // Resolve the card before any write so an invalid reference never reaches
    // the invoice collection.
    const card: Card | null = await this.cardRepository.findById(cardId);
    if (!card) {
      throw new NotFoundError(`Card ${cardId} was not found.`);
    }

    const normalizedAmount = roundCurrency(amount);
    const projectedDueDate = calculateCardDueDate(expectedDate, card.closing_day, card.due_day);
    const period = projectedDueDate.substring(0, 7);

    let invoice = await this.invoiceRepository.findByPeriodAndCard(cardId, period);
    const amountDelta = type === 'expense' ? normalizedAmount : -normalizedAmount;

    if (invoice) {
      const newTotal = sum(invoice.total_amount, amountDelta);
      return await this.invoiceRepository.update(invoice.id, {
        total_amount: newTotal
      });
    }

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
