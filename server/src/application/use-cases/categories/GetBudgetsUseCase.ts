import { CategoryRepository } from '../../../domain/interfaces/CategoryRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { sum, sub } from '../../../domain/utils/mathUtils';

interface EnrichedCategory {
  id: string;
  name: string;
  monthly_budget: number;
  spent: number;
}

export class GetBudgetsUseCase {
  constructor(
    private readonly categoryRepository: CategoryRepository,
    private readonly transactionRepository: TransactionRepository
  ) {}

  async execute(): Promise<EnrichedCategory[]> {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();

    const startOfMonth = new Date(Date.UTC(year, month, 1)).toISOString();
    const endOfMonth = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)).toISOString();

    // 1. Busca todas as categorias
    const categories = await this.categoryRepository.listAll();

    // 2. Busca todas as transações do mês relevantes
    const monthlyTransactions = await this.transactionRepository.listAll({
      filter: `(type = 'expense' || type = 'income') && ( (purchase_date != "" && purchase_date >= '${startOfMonth}' && purchase_date <= '${endOfMonth}') || (purchase_date = "" && expected_date >= '${startOfMonth}' && expected_date <= '${endOfMonth}') )`
    });

    // 3. Agrupa por categoria na memória e calcula os totais
    return categories.map((cat) => {
      const catTxns = monthlyTransactions.filter(t => t.category_id === cat.id);
      const spent = catTxns.reduce((acc, t) => {
        if (t.type === 'expense') return sum(acc, t.amount || 0);
        if (t.type === 'income') return sub(acc, t.amount || 0);
        return acc;
      }, 0);

      return {
        id: cat.id,
        name: cat.name,
        monthly_budget: cat.monthly_budget || 0,
        spent,
      };
    });
  }
}
