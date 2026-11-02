import { Transaction } from '../../../domain/entities/Transaction';
import { Account } from '../../../domain/entities/Account';
import { Card } from '../../../domain/entities/Card';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { calculateCardDueDate } from '../../../domain/utils/dateUtils';
import { roundCurrency, sum, sub } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

/** Empty relation strings from storage mean "no relation". */
function relation(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

export class CreateTransactionUseCase {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly accountRepository: AccountRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase,
    private readonly cardRepository: CardRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(body: Partial<Transaction>): Promise<Transaction> {
    const data: Partial<Transaction> = { ...body };

    data.account_id = relation(data.account_id);
    data.card_id = relation(data.card_id);
    data.category_id = relation(data.category_id);
    data.project_id = relation(data.project_id);
    data.recurrence_id = relation(data.recurrence_id);
    data.destination_account_id = relation(data.destination_account_id);

    if (!data.title || !data.title.trim()) {
      throw new ValidationError('Transaction title cannot be empty.');
    }
    if (!Number.isFinite(data.amount) || (data.amount as number) <= 0) {
      throw new ValidationError('Transaction amount must be greater than zero.');
    }
    if (!data.expected_date) {
      throw new ValidationError('Transaction expected_date is required.');
    }
    data.amount = roundCurrency(data.amount as number);

    // A transfer owns both account legs and no card or category. Any other
    // type may not carry a destination.
    if (data.type === 'transfer') {
      data.card_id = undefined;
      data.category_id = undefined;
      data.purchase_date = undefined;
      data.invoice_id = undefined;
    } else if (data.destination_account_id) {
      throw new ValidationError('Only transfers may set destination_account_id.');
    }

    if (data.card_id && data.account_id) {
      throw new ValidationError('A card transaction cannot also use a bank account.');
    }

    // Resolve every referenced account and card before the first write.
    let sourceAccount: Account | null = null;
    let destinationAccount: Account | null = null;
    let card: Card | null = null;

    if (data.account_id) {
      sourceAccount = await this.accountRepository.findById(data.account_id);
      if (!sourceAccount) throw new NotFoundError(`Account ${data.account_id} was not found.`);
    }
    if (data.destination_account_id) {
      destinationAccount = await this.accountRepository.findById(data.destination_account_id);
      if (!destinationAccount) throw new NotFoundError(`Account ${data.destination_account_id} was not found.`);
    }
    if (data.card_id) {
      card = await this.cardRepository.findById(data.card_id);
      if (!card) throw new NotFoundError(`Card ${data.card_id} was not found.`);
    }

    if (data.type === 'transfer') {
      if (!data.account_id || !data.destination_account_id) {
        throw new ValidationError('A transfer requires a source and a destination account.');
      }
      if (data.account_id === data.destination_account_id) {
        throw new ValidationError('A transfer cannot use the same account on both sides.');
      }
    }

    const isSimulated = data.is_simulated === true;
    const isSilent = data.is_silent === true;
    const amount = data.amount as number;

    // Lifecycle defaults use the injected clock so an offline operation keeps
    // its business date.
    if (data.status === 'realized') {
      data.is_scheduled = false;
      if (!data.realized_date) data.realized_date = this.clock.now();
    } else {
      data.realized_date = undefined;
      data.is_silent = false;
    }

    if (data.card_id && card) {
      const purchaseDate = (data.purchase_date || data.expected_date) as string;
      data.purchase_date = purchaseDate;
      data.status = 'pending';
      data.realized_date = undefined;
      data.is_silent = false;

      if (isSimulated) {
        // A what-if purchase never touches a real invoice.
        data.invoice_id = undefined;
        data.expected_date = calculateCardDueDate(purchaseDate, card.closing_day, card.due_day);
      } else {
        const invoice = await this.syncInvoiceUseCase.execute(
          data.card_id,
          purchaseDate,
          amount,
          data.type as string
        );
        data.invoice_id = invoice.id;
        data.expected_date = invoice.due_date;
      }
    }

    if (data.status === 'realized' && !isSimulated && !isSilent) {
      if (data.type === 'transfer' && sourceAccount && destinationAccount) {
        await this.accountRepository.update(sourceAccount.id, {
          initial_balance: sub(sourceAccount.initial_balance, amount)
        });
        await this.accountRepository.update(destinationAccount.id, {
          initial_balance: sum(destinationAccount.initial_balance, amount)
        });
      } else if (sourceAccount && data.type !== 'transfer') {
        const delta = data.type === 'income' ? amount : -amount;
        await this.accountRepository.update(sourceAccount.id, {
          initial_balance: sum(sourceAccount.initial_balance, delta)
        });
      }
    }

    return await this.transactionRepository.create(data);
  }
}
