import { Account } from '../entities/Account';
import { ListOptions } from './Common';

export interface AccountRepository {
  findById(id: string): Promise<Account>;
  listAll(options?: ListOptions): Promise<Account[]>;
  create(data: Partial<Account>): Promise<Account>;
  update(id: string, data: Partial<Account>): Promise<Account>;
  delete(id: string): Promise<void>;
}
