import { ProjectRepository } from '../../../domain/interfaces/ProjectRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { Transaction } from '../../../domain/entities/Transaction';
import { NotFoundError } from '../../../domain/errors';

export class RegisterPaymentUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly transactionRepository: TransactionRepository
  ) {}

  async execute(projectId: string, body: { amount: number; description?: string }): Promise<Transaction> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundError('Projeto não encontrado.');
    }

    const now = new Date().toISOString();
    return await this.transactionRepository.create({
      title: body.description || `Pagamento — ${project.name}`,
      amount: body.amount,
      type: 'income',
      status: 'realized',
      expected_date: now,
      realized_date: now,
      project_id: projectId
    });
  }
}
