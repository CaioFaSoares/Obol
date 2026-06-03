import { Recurrence } from '../../../domain/entities/Recurrence';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';

export class ToggleRecurrenceStatusUseCase {
  constructor(private readonly recurrenceRepository: RecurrenceRepository) {}

  async execute(id: string, status: 'active' | 'paused'): Promise<Recurrence> {
    return await this.recurrenceRepository.update(id, { status });
  }
}
