import { Card } from '../../../domain/entities/Card';
import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { roundCurrency } from '../../../domain/utils/mathUtils';

export class UpdateCardUseCase {
  constructor(private readonly cardRepository: CardRepository) {}

  async execute(id: string, data: Partial<Card>): Promise<Card> {
    if (data.limit !== undefined) {
      data = { ...data, limit: roundCurrency(data.limit) };
    }
    return await this.cardRepository.update(id, data);
  }
}
