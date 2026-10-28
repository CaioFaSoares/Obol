import { describe, expect, test } from 'bun:test';
import { SummarizeTransactionsUseCase } from '../src/application/use-cases/transactions/SummarizeTransactionsUseCase';
import { TransactionQueryFilters, TransactionSummaryRow } from '../src/domain/interfaces/TransactionQuery';

describe('SummarizeTransactionsUseCase', () => {
  test('sums income and expense precisely, excludes transfers from money totals, counts every matching row', async () => {
    const rows: TransactionSummaryRow[] = [
      { amount: 100.1, type: 'income' },
      { amount: 0.2, type: 'income' },
      { amount: 25.1, type: 'expense' },
      { amount: 500, type: 'transfer' }
    ];
    const useCase = new SummarizeTransactionsUseCase({
      async listForSummary() {
        return rows;
      }
    });

    const filters: TransactionQueryFilters = {
      status: 'realized',
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31'
    };
    const result = await useCase.execute(filters);

    expect(result).toEqual({
      incomeTotal: 100.3,
      expenseTotal: 25.1,
      netTotal: 75.2,
      count: 4
    });
  });

  test('returns zero totals for an empty filter result', async () => {
    const useCase = new SummarizeTransactionsUseCase({
      async listForSummary() {
        return [];
      }
    });

    await expect(useCase.execute({ simulation: 'simulated' })).resolves.toEqual({
      incomeTotal: 0,
      expenseTotal: 0,
      netTotal: 0,
      count: 0
    });
  });
});
