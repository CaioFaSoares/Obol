import { CategoryRepository } from '../../../domain/interfaces/CategoryRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { addUtcMonths, startOfUtcMonth } from '../../../domain/utils/dateUtils';
import { roundCurrency, sum } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

interface EnrichedCategory {
  id: string;
  name: string;
  monthly_budget: number;
  spent: number;
}

/**
 * Accrual budget for the UTC month containing the injected clock instant.
 *
 * Expenses count on `purchase_date` when present (card purchases), otherwise
 * on `expected_date`, regardless of status. This planned basis deliberately
 * includes pending and simulated rows; `spent` is expenses minus incomes.
 */
export class GetBudgetsUseCase {
  constructor(
    private readonly categoryRepository: CategoryRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(): Promise<EnrichedCategory[]> {
    const monthStart = startOfUtcMonth(this.clock.now());
    const nextMonth = addUtcMonths(monthStart, 1);

    const categories = await this.categoryRepository.listAll();
    const transactions = await this.transactionRepository.listAll();

    const totals = new Map<string, number>();
    for (const txn of transactions) {
      if (txn.type !== 'income' && txn.type !== 'expense') continue;
      if (!txn.category_id) continue;

      const accrualDate = new Date(txn.purchase_date || txn.expected_date);
      if (accrualDate < monthStart || accrualDate >= nextMonth) continue;

      const signed = txn.type === 'expense' ? roundCurrency(txn.amount) : -roundCurrency(txn.amount);
      totals.set(txn.category_id, sum(totals.get(txn.category_id) ?? 0, signed));
    }

    return categories.map(category => ({
      id: category.id,
      name: category.name,
      monthly_budget: category.monthly_budget ?? 0,
      spent: roundCurrency(totals.get(category.id) ?? 0)
    }));
  }
}
