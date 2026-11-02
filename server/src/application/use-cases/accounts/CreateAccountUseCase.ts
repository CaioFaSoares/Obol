import { Account } from '../../../domain/entities/Account';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { roundCurrency } from '../../../domain/utils/mathUtils';

export class CreateAccountUseCase {
  constructor(private readonly accountRepository: AccountRepository) {}

  async execute(data: Partial<Account>): Promise<Account> {
    if (data.initial_balance !== undefined) {
      data = { ...data, initial_balance: roundCurrency(data.initial_balance) };
    }
    return await this.accountRepository.create(data);
  }
}
