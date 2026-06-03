import { Transaction } from '../entities/Transaction';
import { ListOptions, PaginatedResult } from './Common';

export interface TransactionRepository {
  findById(id: string): Promise<Transaction>;
  list(options: ListOptions): Promise<PaginatedResult<Transaction>>;
  listAll(options?: ListOptions): Promise<Transaction[]>;
  create(data: Partial<Transaction>): Promise<Transaction>;
  update(id: string, data: Partial<Transaction>): Promise<Transaction>;
  delete(id: string): Promise<void>;
}
