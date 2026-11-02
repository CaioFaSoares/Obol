import { Transaction } from '../../../domain/entities/Transaction';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { roundCurrency, sum, sub } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

export class RealizeTransactionUseCase {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly accountRepository: AccountRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(id: string, body: { update_balance?: boolean }): Promise<Transaction> {
    const txn = await this.transactionRepository.findById(id);
    if (!txn) {
      throw new NotFoundError('Transaction was not found.');
    }

    if (txn.status === 'realized') {
      throw new ValidationError('Transaction is already realized.');
    }
    if (txn.is_simulated === true) {
      throw new ValidationError('A simulated transaction must be converted before realization.');
    }

    const shouldUpdateBalance = body.update_balance !== false;
    const amount = roundCurrency(txn.amount);

    if (shouldUpdateBalance) {
      if (txn.type === 'transfer' && txn.account_id && txn.destination_account_id) {
        const source = await this.accountRepository.findById(txn.account_id);
        const destination = await this.accountRepository.findById(txn.destination_account_id);
        if (!source) throw new NotFoundError(`Account ${txn.account_id} was not found.`);
        if (!destination) throw new NotFoundError(`Account ${txn.destination_account_id} was not found.`);

        await this.accountRepository.update(source.id, {
          initial_balance: sub(source.initial_balance, amount)
        });
        await this.accountRepository.update(destination.id, {
          initial_balance: sum(destination.initial_balance, amount)
        });
      } else if (txn.account_id && txn.type !== 'transfer') {
        const account = await this.accountRepository.findById(txn.account_id);
        if (!account) throw new NotFoundError(`Account ${txn.account_id} was not found.`);
        const delta = txn.type === 'income' ? amount : -amount;
        await this.accountRepository.update(account.id, {
          initial_balance: sum(account.initial_balance, delta)
        });
      }
    }

    return await this.transactionRepository.update(txn.id, {
      status: 'realized',
      realized_date: this.clock.now(),
      is_silent: !shouldUpdateBalance,
      is_scheduled: false
    });
  }
}
