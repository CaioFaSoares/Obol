import { ProjectRepository } from '../../../domain/interfaces/ProjectRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { Transaction } from '../../../domain/entities/Transaction';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { roundCurrency } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

export class RegisterPaymentUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(projectId: string, body: { amount: number; description?: string }): Promise<Transaction> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundError('Project was not found.');
    }
    if (!Number.isFinite(body.amount) || body.amount <= 0) {
      throw new ValidationError('Project payment must be greater than zero.');
    }

    const payment = roundCurrency(body.amount);
    const now = this.clock.now();

    return await this.transactionRepository.create({
      title: body.description || `Pagamento — ${project.name}`,
      amount: payment,
      type: 'income',
      status: 'realized',
      expected_date: now,
      realized_date: now,
      project_id: projectId
    });
  }
}
