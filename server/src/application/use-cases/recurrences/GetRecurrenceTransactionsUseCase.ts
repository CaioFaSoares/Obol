import { Transaction } from '../../../domain/entities/Transaction';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';

export class GetRecurrenceTransactionsUseCase {
  constructor(private readonly transactionRepository: TransactionRepository) {}

  async execute(recurrenceId: string): Promise<Transaction[]> {
    return await this.transactionRepository.listAll({
      filter: `recurrence_id = '${recurrenceId}'`,
      sort: '-expected_date'
    });
  }
}
