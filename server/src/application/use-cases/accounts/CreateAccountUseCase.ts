import { Account } from '../../../domain/entities/Account';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';

export class CreateAccountUseCase {
  constructor(private readonly accountRepository: AccountRepository) {}

  async execute(data: Partial<Account>): Promise<Account> {
    return await this.accountRepository.create(data);
  }
}
