import PocketBase from 'pocketbase';
import { Transaction } from '../../domain/entities/Transaction';
import { TransactionRepository } from '../../domain/interfaces/TransactionRepository';
import { ListOptions, PaginatedResult } from '../../domain/interfaces/Common';

export class PocketbaseTransactionRepository implements TransactionRepository {
  constructor(private readonly pb: PocketBase) {}

  async findById(id: string): Promise<Transaction> {
    const record = await this.pb.collection('transactions').getOne(id);
    return record as unknown as Transaction;
  }

  async list(options: ListOptions): Promise<PaginatedResult<Transaction>> {
    const page = options.page || 1;
    const perPage = options.perPage || 15;
    const pbOptions: any = {
      sort: options.sort || '-expected_date',
    };
    if (options.filter) {
      pbOptions.filter = options.filter;
    }
    const result = await this.pb.collection('transactions').getList(page, perPage, pbOptions);
    return {
      items: result.items as unknown as Transaction[],
      page: result.page,
      perPage: result.perPage,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
    };
  }

  async listAll(options?: ListOptions): Promise<Transaction[]> {
    const pbOptions: any = {};
    if (options?.sort) {
      pbOptions.sort = options.sort;
    }
    if (options?.filter) {
      pbOptions.filter = options.filter;
    }
    const records = await this.pb.collection('transactions').getFullList(pbOptions);
    return records as unknown as Transaction[];
  }

  async create(data: Partial<Transaction>): Promise<Transaction> {
    const record = await this.pb.collection('transactions').create(data);
    return record as unknown as Transaction;
  }

  async update(id: string, data: Partial<Transaction>): Promise<Transaction> {
    const record = await this.pb.collection('transactions').update(id, data);
    return record as unknown as Transaction;
  }

  async delete(id: string): Promise<void> {
    await this.pb.collection('transactions').delete(id);
  }
}
