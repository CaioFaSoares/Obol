import { Card } from '../../../domain/entities/Card';
import { CardRepository } from '../../../domain/interfaces/CardRepository';

export class UpdateCardUseCase {
  constructor(private readonly cardRepository: CardRepository) {}

  async execute(id: string, data: Partial<Card>): Promise<Card> {
    return await this.cardRepository.update(id, data);
  }
}
