import { Recurrence } from '../../../domain/entities/Recurrence';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';

export class UpdateRecurrenceUseCase {
  constructor(private readonly recurrenceRepository: RecurrenceRepository) {}

  async execute(id: string, data: Partial<Recurrence>): Promise<Recurrence> {
    return await this.recurrenceRepository.update(id, data);
  }
}
