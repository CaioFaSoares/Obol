import PocketBase from 'pocketbase';
import { Transaction } from '../../domain/entities/Transaction';
import { ValidationError } from '../../domain/errors';
import { TransactionRepository } from '../../domain/interfaces/TransactionRepository';
import { ListOptions, PaginatedResult } from '../../domain/interfaces/Common';
import {
  TransactionListItem,
  TransactionListOptions,
  TransactionQueryFilters,
  TransactionSummaryRow
} from '../../domain/interfaces/TransactionQuery';

interface ExpandedTransactionRecord extends Transaction {
  expand?: {
    invoice_id?: {
      period?: string;
    };
  };
}

const SORT_FIELDS: Record<string, true> = {
  expected_date: true,
  realized_date: true,
  amount: true,
  created: true
};

export class PocketbaseTransactionRepository implements TransactionRepository {
  constructor(private readonly pb: PocketBase) {}

  async findById(id: string): Promise<Transaction> {
    const record = await this.pb.collection('transactions').getOne(id);
    return record as unknown as Transaction;
  }

  async list(options: TransactionListOptions): Promise<PaginatedResult<TransactionListItem>> {
    const page = options.page || 1;
    const perPage = options.perPage || 15;
    const filter = this.buildFilter(options);
    const result = await this.pb.collection('transactions').getList(page, perPage, {
      sort: this.buildSort(options.sort),
      ...(filter ? { filter } : {}),
      ...(options.expandInvoice ? { expand: 'invoice_id' } : {})
    });
    const records = result.items as unknown as ExpandedTransactionRecord[];
    const items: TransactionListItem[] = options.expandInvoice
      ? records.map(({ expand, ...transaction }) => ({
          ...transaction,
          invoice_period: expand?.invoice_id?.period
        }))
      : records;
    return {
      items,
      page: result.page,
      perPage: result.perPage,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
    };
  }
  async listAll(options?: ListOptions): Promise<Transaction[]> {
    const filter = options?.filter;
    const result = await this.pb.collection('transactions').getFullList({
      ...(options?.sort ? { sort: this.buildSort(options.sort) } : {}),
      ...(filter ? { filter } : {})
    });
    return result as unknown as Transaction[];
  }

  async listForSummary(filters: TransactionQueryFilters): Promise<TransactionSummaryRow[]> {
    const filter = this.buildFilter(filters);
    const result = await this.pb.collection('transactions').getFullList({
      fields: 'amount,type',
      ...(filter ? { filter } : {})
    });
    return result as unknown as TransactionSummaryRow[];
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

  private buildSort(sort?: string): string {
    const requested = sort || '-expected_date';
    const descending = requested.startsWith('-');
    const field = requested.replace(/^[+-]/, '');
    if (!SORT_FIELDS[field]) {
      throw new ValidationError(`Unsupported transaction sort field: ${field}`);
    }
    return `${descending ? '-' : ''}${field}`;
  }

  private buildFilter(options: ListOptions & TransactionQueryFilters): string | undefined {
    const conditions: string[] = [];
    if (options.filter?.trim()) conditions.push(options.filter);

    const search = options.search?.trim();
    if (search) {
      conditions.push(this.pb.filter('title ~ {:search}', { search }));
    }
    if (options.status && options.status !== 'all') {
      conditions.push(this.pb.filter('status = {:status}', { status: options.status }));
    }
    if (options.type && options.type !== 'all') {
      conditions.push(this.pb.filter('type = {:type}', { type: options.type }));
    }
    if (options.simulation === 'real') conditions.push('is_simulated = false');
    if (options.simulation === 'simulated') conditions.push('is_simulated = true');
    if (options.scheduled === 'scheduled') conditions.push('is_scheduled = true');
    if (options.scheduled === 'unscheduled') conditions.push('is_scheduled = false');
    if (options.accountId) {
      conditions.push(this.pb.filter(
        '(account_id = {:accountId} || destination_account_id = {:accountId})',
        { accountId: options.accountId }
      ));
    }
    if (options.cardId) {
      conditions.push(this.pb.filter('card_id = {:cardId}', { cardId: options.cardId }));
    }
    if (options.categoryId) {
      conditions.push(this.pb.filter('category_id = {:categoryId}', { categoryId: options.categoryId }));
    }

    if (options.dateFrom && options.dateTo && options.dateFrom > options.dateTo) {
      throw new ValidationError('dateFrom must be on or before dateTo');
    }
    if (options.dateFrom || options.dateTo) {
      const dateField = options.dateField ??
        (options.status === 'realized' ? 'realized_date' : 'expected_date');
      if (options.dateFrom) {
        conditions.push(this.pb.filter(
          `${dateField} >= {:dateFrom}`,
          { dateFrom: `${options.dateFrom} 00:00:00.000Z` }
        ));
      }
      if (options.dateTo) {
        conditions.push(this.pb.filter(
          `${dateField} <= {:dateTo}`,
          { dateTo: `${options.dateTo} 23:59:59.999Z` }
        ));
      }
    }

    return conditions.length ? conditions.map(condition => `(${condition})`).join(' && ') : undefined;
  }
}
