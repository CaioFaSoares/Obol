import { ListOptions, PaginatedResult } from '../../../domain/interfaces/Common';
import { Transaction } from '../../../domain/entities/Transaction';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';

export class ListTransactionsUseCase {
  constructor(private readonly transactionRepository: TransactionRepository) {}

  async execute(options: ListOptions): Promise<PaginatedResult<Transaction>> {
    return await this.transactionRepository.list(options);
  }
}
