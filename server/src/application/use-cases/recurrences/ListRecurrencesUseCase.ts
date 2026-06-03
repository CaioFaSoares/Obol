import { Recurrence } from '../../../domain/entities/Recurrence';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';

export class ListRecurrencesUseCase {
  constructor(private readonly recurrenceRepository: RecurrenceRepository) {}

  async execute(): Promise<Recurrence[]> {
    return await this.recurrenceRepository.listAll();
  }
}
