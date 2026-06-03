import { Account } from '../../../domain/entities/Account';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';

export class ListAccountsUseCase {
  constructor(private readonly accountRepository: AccountRepository) {}

  async execute(): Promise<Account[]> {
    return await this.accountRepository.listAll();
  }
}
