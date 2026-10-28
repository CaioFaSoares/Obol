import { TransactionListItem, TransactionListOptions } from '../../../domain/interfaces/TransactionQuery';
import { PaginatedResult } from '../../../domain/interfaces/Common';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';

export class ListTransactionsUseCase {
  constructor(private readonly transactionRepository: TransactionRepository) {}

  async execute(options: TransactionListOptions): Promise<PaginatedResult<TransactionListItem>> {
    return await this.transactionRepository.list(options);
  }
}
