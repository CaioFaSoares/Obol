import { Transaction, TransactionUpdatePatch, storedTransactionFields } from '../../../domain/entities/Transaction';
import { Invoice } from '../../../domain/entities/Invoice';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
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

/**
 * Patch semantics for one clearable text field: an omitted field keeps the
 * stored value, `null` clears it and any other value replaces it.
 */
function patchedText(stored: string | undefined, incoming: string | null | undefined): string | undefined {
  if (incoming === null) return undefined;
  if (incoming === undefined) return relation(stored);
  return relation(incoming);
}

/**
 * Day identity of a purchase date. Storage emits `YYYY-MM-DD HH:MM:SS.sssZ`
 * and the client emits ISO, so the separator is normalized before comparing;
 * invoice routing only depends on the UTC day.
 */
function purchaseDay(value: string | undefined): string {
  return value ? value.replace(' ', 'T').slice(0, 10) : '';
}

export class UpdateTransactionUseCase {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly accountRepository: AccountRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase,
    private readonly cardRepository: CardRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(id: string, body: TransactionUpdatePatch): Promise<Transaction> {
    const oldTxn = await this.transactionRepository.findById(id);
    if (!oldTxn) {
      throw new NotFoundError('Transaction was not found.');
    }

    // A patch carries only the fields the caller changed. The final state is
    // stored state plus that patch, never just the repeated fields.
    const final: Transaction = {
      ...oldTxn,
      title: body.title ?? oldTxn.title,
      amount: body.amount ?? oldTxn.amount,
      type: body.type ?? oldTxn.type,
      status: body.status ?? oldTxn.status,
      expected_date: body.expected_date ?? oldTxn.expected_date,
      realized_date: patchedText(oldTxn.realized_date, body.realized_date),
      purchase_date: patchedText(oldTxn.purchase_date, body.purchase_date),
      is_recurring: body.is_recurring ?? oldTxn.is_recurring,
      is_silent: body.is_silent ?? oldTxn.is_silent,
      is_simulated: body.is_simulated ?? oldTxn.is_simulated,
      is_scheduled: body.is_scheduled ?? oldTxn.is_scheduled,
      account_id: patchedText(oldTxn.account_id, body.account_id),
      card_id: patchedText(oldTxn.card_id, body.card_id),
      category_id: patchedText(oldTxn.category_id, body.category_id),
      project_id: patchedText(oldTxn.project_id, body.project_id),
      destination_account_id: patchedText(oldTxn.destination_account_id, body.destination_account_id),
      invoice_id: relation(oldTxn.invoice_id),
      recurrence_id: relation(oldTxn.recurrence_id)
    };

    if (!final.title || !final.title.trim()) {
      throw new ValidationError('Transaction title cannot be empty.');
    }
    if (!Number.isFinite(final.amount) || final.amount <= 0) {
      throw new ValidationError('Transaction amount must be greater than zero.');
    }
    final.amount = roundCurrency(final.amount);

    if (final.type === 'transfer') {
      final.card_id = undefined;
      final.category_id = undefined;
      final.purchase_date = undefined;
    } else {
      // A non-transfer owns no destination, and a card origin and a bank
      // account origin can never survive together. Both are rejected instead
      // of silently dropping one of them.
      if (final.destination_account_id) {
        throw new ValidationError('Only transfers may set destination_account_id.');
      }
      if (final.card_id && final.account_id) {
        throw new ValidationError('A card transaction cannot also use a bank account.');
      }
    }

    // The edit form sends the purchase date in expected_date for card rows.
    if (oldTxn.card_id && body.purchase_date === undefined && body.expected_date !== undefined && final.card_id) {
      final.purchase_date = body.expected_date;
    }

    // Resolve references before any write.
    if (final.account_id) {
      const account = await this.accountRepository.findById(final.account_id);
      if (!account) throw new NotFoundError(`Account ${final.account_id} was not found.`);
    }
    if (final.destination_account_id) {
      const account = await this.accountRepository.findById(final.destination_account_id);
      if (!account) throw new NotFoundError(`Account ${final.destination_account_id} was not found.`);
    }
    const card = final.card_id ? await this.cardRepository.findById(final.card_id) : null;
    if (final.card_id && !card) {
      throw new NotFoundError(`Card ${final.card_id} was not found.`);
    }

    if (final.type === 'transfer') {
      if (!final.account_id || !final.destination_account_id) {
        throw new ValidationError('A transfer requires a source and a destination account.');
      }
      if (final.account_id === final.destination_account_id) {
        throw new ValidationError('A transfer cannot use the same account on both sides.');
      }
    }

    if (final.status === 'realized') {
      final.is_scheduled = false;
      if (!final.realized_date) final.realized_date = this.clock.now();
    } else {
      final.realized_date = undefined;
      final.is_silent = false;
    }

    const cardChanged =
      oldTxn.card_id !== final.card_id ||
      oldTxn.amount !== final.amount ||
      oldTxn.type !== final.type ||
      purchaseDay(oldTxn.purchase_date) !== purchaseDay(final.purchase_date);

    let oldInvoice: Invoice | null = null;
    if (oldTxn.is_simulated !== true && oldTxn.invoice_id) {
      oldInvoice = await this.invoiceRepository.findById(oldTxn.invoice_id);
      if (!oldInvoice) {
        throw new NotFoundError(`Invoice ${oldTxn.invoice_id} was not found.`);
      }
    }

    // Revert the financial effect of the stored row, then apply the final one.
    if (oldTxn.is_simulated !== true) {
      if (oldTxn.status === 'realized' && oldTxn.is_silent !== true) {
        await this.applyAccountEffect(oldTxn, -1);
      }
      if (oldInvoice) {
        // An expense added to an invoice total, so reverting one subtracts
        // it; an income subtracted, so reverting one adds it back.
        const oldAmount = roundCurrency(oldTxn.amount);
        const revertDelta = oldTxn.type === 'expense' ? -oldAmount : oldAmount;
        await this.invoiceRepository.update(oldInvoice.id, {
          total_amount: sum(oldInvoice.total_amount, revertDelta)
        });
      }
    }

    if (final.card_id && card) {
      const purchaseDate = final.purchase_date || final.expected_date;
      final.purchase_date = purchaseDate;

      if (final.is_simulated === true) {
        final.invoice_id = undefined;
        final.expected_date = calculateCardDueDate(purchaseDate, card.closing_day, card.due_day);
        final.status = 'pending';
        final.realized_date = undefined;
        final.is_silent = false;
      } else {
        const invoice = await this.syncInvoiceUseCase.execute(
          final.card_id,
          purchaseDate,
          final.amount,
          final.type as string
        );
        final.invoice_id = invoice.id;
        final.expected_date = invoice.due_date;
        if (cardChanged) {
          final.status = 'pending';
          final.realized_date = undefined;
          final.is_silent = false;
          final.is_scheduled = false;
        }
      }
    } else {
      final.invoice_id = undefined;
      if (oldTxn.card_id && body.purchase_date === undefined && body.expected_date === undefined) {
        final.purchase_date = undefined;
      }
    }

    if (final.status === 'realized' && final.is_simulated !== true && final.is_silent !== true) {
      await this.applyAccountEffect(final, 1);
    }

    return await this.transactionRepository.update(id, storedTransactionFields(final));
  }

  /** Applies (direction 1) or reverts (-1) the stored account effect. */
  private async applyAccountEffect(txn: Transaction, direction: 1 | -1): Promise<void> {
    const amount = roundCurrency(txn.amount);
    if (txn.type === 'transfer') {
      if (!txn.account_id || !txn.destination_account_id) return;
      const source = await this.accountRepository.findById(txn.account_id);
      const destination = await this.accountRepository.findById(txn.destination_account_id);
      if (!source) throw new NotFoundError(`Account ${txn.account_id} was not found.`);
      if (!destination) throw new NotFoundError(`Account ${txn.destination_account_id} was not found.`);
      await this.accountRepository.update(source.id, {
        initial_balance: sub(source.initial_balance, amount * direction)
      });
      await this.accountRepository.update(destination.id, {
        initial_balance: sum(destination.initial_balance, amount * direction)
      });
      return;
    }

    if (!txn.account_id) return;
    const account = await this.accountRepository.findById(txn.account_id);
    if (!account) throw new NotFoundError(`Account ${txn.account_id} was not found.`);
    const delta = (txn.type === 'income' ? amount : -amount) * direction;
    await this.accountRepository.update(account.id, {
      initial_balance: sum(account.initial_balance, delta)
    });
  }
}
