import { TransactionQueryFilters, TransactionSummary } from '../../../domain/interfaces/TransactionQuery';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { sub, sum } from '../../../domain/utils/mathUtils';

export class SummarizeTransactionsUseCase {
  constructor(
    private readonly transactionRepository: Pick<TransactionRepository, 'listForSummary'>
  ) {}

  async execute(filters: TransactionQueryFilters): Promise<TransactionSummary> {
    const rows = await this.transactionRepository.listForSummary(filters);
    let incomeTotal = 0;
    let expenseTotal = 0;

    for (const row of rows) {
      if (row.type === 'income') incomeTotal = sum(incomeTotal, row.amount);
      if (row.type === 'expense') expenseTotal = sum(expenseTotal, row.amount);
    }

    return {
      incomeTotal,
      expenseTotal,
      netTotal: sub(incomeTotal, expenseTotal),
      count: rows.length
    };
  }
}
