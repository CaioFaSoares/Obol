import { Recurrence } from '../../../domain/entities/Recurrence';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';

export class CreateRecurrenceUseCase {
  constructor(private readonly recurrenceRepository: RecurrenceRepository) {}

  async execute(data: Partial<Recurrence>): Promise<Recurrence> {
    return await this.recurrenceRepository.create({
      ...data,
      status: 'active'
    });
  }
}
