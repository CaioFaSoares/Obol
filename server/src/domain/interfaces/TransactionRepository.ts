import { Transaction } from '../entities/Transaction';
import { ListOptions, PaginatedResult } from './Common';
import { TransactionListItem, TransactionListOptions, TransactionQueryFilters, TransactionSummaryRow } from './TransactionQuery';

export interface TransactionRepository {
  findById(id: string): Promise<Transaction>;
  list(options: TransactionListOptions): Promise<PaginatedResult<TransactionListItem>>;
  listAll(options?: ListOptions): Promise<Transaction[]>;
  listForSummary(filters: TransactionQueryFilters): Promise<TransactionSummaryRow[]>;
  create(data: Partial<Transaction>): Promise<Transaction>;
  update(id: string, data: Partial<Transaction>): Promise<Transaction>;
  delete(id: string): Promise<void>;
}
