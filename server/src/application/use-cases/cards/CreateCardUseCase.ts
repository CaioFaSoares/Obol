import { Card } from '../../../domain/entities/Card';
import { CardRepository } from '../../../domain/interfaces/CardRepository';

export class CreateCardUseCase {
  constructor(private readonly cardRepository: CardRepository) {}

  async execute(data: Partial<Card>): Promise<Card> {
    return await this.cardRepository.create(data);
  }
}
