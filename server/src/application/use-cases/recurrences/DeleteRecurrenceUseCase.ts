import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';

export class DeleteRecurrenceUseCase {
  constructor(private readonly recurrenceRepository: RecurrenceRepository) {}

  async execute(id: string): Promise<{ success: boolean }> {
    await this.recurrenceRepository.update(id, { status: 'ended' });
    return { success: true };
  }
}
