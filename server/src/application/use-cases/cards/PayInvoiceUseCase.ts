import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { roundCurrency, sum, sub } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

interface PayInvoiceInput {
  cardId: string;
  period: string;
  accountId?: string;
  amountPaid?: number;
  ignoreBalance?: boolean;
}

interface PayInvoiceResult {
  success: boolean;
  message: string;
  new_account_balance: number | null;
}

export class PayInvoiceUseCase {
  constructor(
    private readonly cardRepository: CardRepository,
    private readonly accountRepository: AccountRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(input: PayInvoiceInput): Promise<PayInvoiceResult> {
    const { cardId, period, accountId, amountPaid, ignoreBalance } = input;

    const card = await this.cardRepository.findById(cardId);
    if (!card) {
      throw new NotFoundError('Card was not found.');
    }

    const invoice = await this.invoiceRepository.findByPeriodAndCard(cardId, period);
    if (!invoice) {
      throw new NotFoundError(`Invoice for period ${period} was not found.`);
    }
    if (invoice.status === 'PAID') {
      throw new ValidationError('Invoice is already paid.');
    }

    const now = this.clock.now();
    const totalDue = roundCurrency(sub(invoice.total_amount, invoice.paid_amount ?? 0));

    // A silent payoff reconciles the invoice without moving cash or changing
    // the recorded paid amount.
    if (ignoreBalance) {
      await this.invoiceRepository.update(invoice.id, { status: 'PAID' });
      await this.realizeChildren(invoice.id, now);
      return {
        success: true,
        message: `Invoice ${period} was settled silently.`,
        new_account_balance: null
      };
    }

    if (!accountId) {
      throw new ValidationError('account_id is required unless the payoff is silent.');
    }
    const account = await this.accountRepository.findById(accountId);
    if (!account) {
      throw new NotFoundError('Account was not found.');
    }
    if (totalDue <= 0) {
      throw new ValidationError('Invoice has no remaining debt.');
    }

    const requested = amountPaid === undefined ? totalDue : roundCurrency(amountPaid);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new ValidationError('The paid amount must be greater than zero.');
    }
    if (requested > sum(totalDue, 0.01)) {
      throw new ValidationError('The paid amount cannot exceed the remaining invoice debt.');
    }
    const payment = requested > totalDue ? totalDue : requested;

    const newBalance = sub(account.initial_balance, payment);
    await this.accountRepository.update(account.id, {
      initial_balance: newBalance
    });

    await this.transactionRepository.create({
      title: `Pagamento Fatura ${card.name} ${period}`,
      amount: payment,
      type: 'expense',
      status: 'realized',
      account_id: account.id,
      realized_date: now,
      expected_date: now
    });

    const newPaidAmount = roundCurrency(sum(invoice.paid_amount ?? 0, payment));
    const remaining = roundCurrency(sub(invoice.total_amount, newPaidAmount));

    if (remaining > 0.01) {
      await this.invoiceRepository.update(invoice.id, {
        paid_amount: newPaidAmount
      });
      return {
        success: true,
        message: `Partial payment of ${payment.toFixed(2)} recorded.`,
        new_account_balance: newBalance
      };
    }

    await this.invoiceRepository.update(invoice.id, {
      paid_amount: newPaidAmount,
      status: 'PAID'
    });
    await this.realizeChildren(invoice.id, now);

    return {
      success: true,
      message: `Invoice ${period} was paid in full.`,
      new_account_balance: newBalance
    };
  }

  private async realizeChildren(invoiceId: string, now: string): Promise<void> {
    const transactions = await this.transactionRepository.listAll();
    const children = transactions.filter(t => t.invoice_id === invoiceId && t.status === 'pending');
    for (const child of children) {
      await this.transactionRepository.update(child.id, {
        status: 'realized',
        realized_date: now,
        is_scheduled: false
      });
    }
  }
}
