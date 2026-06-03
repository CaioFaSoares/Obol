import { ProjectRepository } from '../../../domain/interfaces/ProjectRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';

interface EnrichedProject {
  id: string;
  name: string;
  total_value: number;
  status: 'active' | 'completed';
  received: number;
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

    const enriched = await Promise.all(
      projects.map(async (project) => {
        // Soma todas as receitas vinculadas ao projeto
        const payments = await this.transactionRepository.listAll({
          filter: `project_id = '${project.id}' && type = 'income'`
        });

        let received = 0;
        const breakdownMap = new Map<string, number>();

        for (const t of payments) {
          const amt = t.amount || 0;
          received += amt;
          
          if (t.account_id) {
            const accName = accountMap.get(t.account_id) || 'Conta Desconhecida';
            const curr = breakdownMap.get(accName) || 0;
            breakdownMap.set(accName, curr + amt);
          } else {
            const curr = breakdownMap.get('Outros/Dinheiro') || 0;
            breakdownMap.set('Outros/Dinheiro', curr + amt);
          }
        }

        const accounts_breakdown = Array.from(breakdownMap.entries()).map(([account_name, amount]) => ({
          account_name,
          amount
        }));

        return {
          id: project.id,
          name: project.name,
          total_value: project.total_value,
          status: project.status,
          received,
          accounts_breakdown
        };
      })
    );

    return enriched;
  }
}
