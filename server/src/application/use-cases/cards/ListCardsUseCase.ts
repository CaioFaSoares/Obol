import { Card } from '../../../domain/entities/Card';
import { CardRepository } from '../../../domain/interfaces/CardRepository';

export class ListCardsUseCase {
  constructor(private readonly cardRepository: CardRepository) {}

  async execute(): Promise<Card[]> {
    return await this.cardRepository.listAll();
  }
}
