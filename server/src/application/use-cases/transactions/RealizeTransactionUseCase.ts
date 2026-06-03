import { Transaction } from '../../../domain/entities/Transaction';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { sum, sub } from '../../../domain/utils/mathUtils';

export class RealizeTransactionUseCase {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly accountRepository: AccountRepository
  ) {}

  async execute(id: string, body: { update_balance?: boolean }): Promise<Transaction> {
    const txn = await this.transactionRepository.findById(id);
    if (!txn) {
      throw new NotFoundError('Transação não encontrada');
    }

    if (txn.status === 'realized') {
      throw new ValidationError('Transação já foi realizada.');
    }

    const shouldUpdateBalance = body.update_balance !== false;

    if (txn.type === 'transfer' && txn.account_id && txn.destination_account_id && shouldUpdateBalance) {
      const sourceAcc = await this.accountRepository.findById(txn.account_id);
      const destAcc = await this.accountRepository.findById(txn.destination_account_id);
      
      await this.accountRepository.update(sourceAcc.id, { 
        initial_balance: sub(sourceAcc.initial_balance, txn.amount) 
      });
      await this.accountRepository.update(destAcc.id, { 
        initial_balance: sum(destAcc.initial_balance, txn.amount) 
      });
    } else if (txn.account_id && shouldUpdateBalance) {
      const account = await this.accountRepository.findById(txn.account_id);
      
      let newBalance = account.initial_balance;
      if (txn.type === 'income') newBalance = sum(newBalance, txn.amount);
      if (txn.type === 'expense') newBalance = sub(newBalance, txn.amount);
      
      await this.accountRepository.update(account.id, { 
        initial_balance: newBalance 
      });
    }

    return await this.transactionRepository.update(txn.id, {
      status: 'realized',
      realized_date: new Date().toISOString(),
      is_silent: !shouldUpdateBalance,
      is_scheduled: false
    });
  }
}
