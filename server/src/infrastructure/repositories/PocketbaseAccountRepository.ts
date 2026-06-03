import PocketBase from 'pocketbase';
import { Account } from '../../domain/entities/Account';
import { AccountRepository } from '../../domain/interfaces/AccountRepository';
import { ListOptions } from '../../domain/interfaces/Common';

export class PocketbaseAccountRepository implements AccountRepository {
  constructor(private readonly pb: PocketBase) {}

  async findById(id: string): Promise<Account> {
    const record = await this.pb.collection('accounts').getOne(id);
    return record as unknown as Account;
  }

  async listAll(options?: ListOptions): Promise<Account[]> {
    const pbOptions: any = {
      sort: options?.sort || 'name',
    };
    if (options?.filter) {
      pbOptions.filter = options.filter;
    }
    const records = await this.pb.collection('accounts').getFullList(pbOptions);
    return records as unknown as Account[];
  }

  async create(data: Partial<Account>): Promise<Account> {
    const record = await this.pb.collection('accounts').create(data);
    return record as unknown as Account;
  }

  async update(id: string, data: Partial<Account>): Promise<Account> {
    const record = await this.pb.collection('accounts').update(id, data);
    return record as unknown as Account;
  }

  async delete(id: string): Promise<void> {
    await this.pb.collection('accounts').delete(id);
  }
}
