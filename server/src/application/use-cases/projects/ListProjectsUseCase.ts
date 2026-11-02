import { ProjectRepository } from '../../../domain/interfaces/ProjectRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { roundCurrency } from '../../../domain/utils/mathUtils';

interface EnrichedProject {
  id: string;
  name: string;
  total_value: number;
  status: 'active' | 'completed';
  received: number;
  remaining: number;
  accounts_breakdown: {
    account_name: string;
    amount: number;
  }[];
}

export class ListProjectsUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly accountRepository: AccountRepository,
    private readonly transactionRepository: TransactionRepository
  ) {}

  async execute(): Promise<EnrichedProject[]> {
    const projects = await this.projectRepository.listAll();
    const accounts = await this.accountRepository.listAll();
    const accountMap = new Map(accounts.map(a => [a.id, a.name]));
    const transactions = await this.transactionRepository.listAll();

    return projects.map(project => {
      // Paid totals count realized, non-simulated incomes only. Pending
      // linked income is not money received yet.
      const payments = transactions.filter(
        t =>
          t.project_id === project.id &&
          t.type === 'income' &&
          t.status === 'realized' &&
          t.is_simulated !== true
      );

      let received = 0;
      const breakdownMap = new Map<string, number>();

      for (const payment of payments) {
        const amount = roundCurrency(payment.amount || 0);
        received = roundCurrency(received + amount);

        const accountName = payment.account_id
          ? accountMap.get(payment.account_id) || 'Conta Desconhecida'
          : 'Outros/Dinheiro';
        breakdownMap.set(accountName, roundCurrency((breakdownMap.get(accountName) ?? 0) + amount));
      }

      return {
        id: project.id,
        name: project.name,
        total_value: project.total_value,
        status: project.status,
        received,
        remaining: roundCurrency(project.total_value - received),
        accounts_breakdown: Array.from(breakdownMap.entries()).map(([account_name, amount]) => ({
          account_name,
          amount
        }))
      };
    });
  }
}
