import { describe, expect, test } from 'bun:test';
import { UpdateTransactionUseCase } from '../src/application/use-cases/transactions/UpdateTransactionUseCase';
import { SyncInvoiceUseCase } from '../src/application/use-cases/invoices/SyncInvoiceUseCase';
import { ValidationError } from '../src/domain/errors';
import type { Account } from '../src/domain/entities/Account';
import type { Card } from '../src/domain/entities/Card';
import type { Invoice } from '../src/domain/entities/Invoice';
import type { Transaction, TransactionUpdatePatch } from '../src/domain/entities/Transaction';
import type { SyncRecurrenceUpdatePayload, SyncTransactionUpdatePayload } from '../src/domain/sync/SyncOperation';

// Real use cases over mutable in-memory storage ports. Each row is plain
// storage state, so every assertion reads what the use cases actually wrote.

class MemoryAccountRepository {
  constructor(readonly rows: Account[]) {}

  private row(id: string): Account {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown account ${id}`);
    return found;
  }

  async findById(id: string): Promise<Account> {
    return this.row(id);
  }

  async listAll(): Promise<Account[]> {
    return this.rows;
  }

  async create(data: Partial<Account>): Promise<Account> {
    const row = { ...data, id: data.id ?? `acc-${this.rows.length + 1}` } as Account;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Account>): Promise<Account> {
    const row = this.row(id);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }

  balance(id: string): number {
    return this.row(id).initial_balance;
  }
}

class MemoryCardRepository {
  constructor(readonly rows: Card[]) {}

  async findById(id: string): Promise<Card> {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown card ${id}`);
    return found;
  }

  async listAll(): Promise<Card[]> {
    return this.rows;
  }

  async create(data: Partial<Card>): Promise<Card> {
    const row = { ...data, id: data.id ?? `card-${this.rows.length + 1}` } as Card;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Card>): Promise<Card> {
    const row = this.rows.find(candidate => candidate.id === id);
    if (!row) throw new Error(`Unknown card ${id}`);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

class MemoryInvoiceRepository {
  constructor(readonly rows: Invoice[]) {}

  async findById(id: string): Promise<Invoice> {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown invoice ${id}`);
    return found;
  }

  async findByPeriodAndCard(cardId: string, period: string): Promise<Invoice | null> {
    return this.rows.find(candidate => candidate.card_id === cardId && candidate.period === period) ?? null;
  }

  async listAll(): Promise<Invoice[]> {
    return this.rows;
  }

  async create(data: Partial<Invoice>): Promise<Invoice> {
    const row = { ...data, id: data.id ?? `inv-${this.rows.length + 1}` } as Invoice;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Invoice>): Promise<Invoice> {
    const row = this.rows.find(candidate => candidate.id === id);
    if (!row) throw new Error(`Unknown invoice ${id}`);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

class MemoryTransactionRepository {
  constructor(readonly rows: Transaction[]) {}

  async findById(id: string): Promise<Transaction> {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown transaction ${id}`);
    return found;
  }

  async list(): Promise<never> {
    throw new Error('list is not part of this contract');
  }

  async listAll(): Promise<Transaction[]> {
    return this.rows;
  }

  async listForSummary(): Promise<never> {
    throw new Error('listForSummary is not part of this contract');
  }

  async create(data: Partial<Transaction>): Promise<Transaction> {
    const row = { ...data, id: data.id ?? `txn-${this.rows.length + 1}` } as Transaction;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Transaction>): Promise<Transaction> {
    const row = await this.findById(id);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

const CARD: Card = { id: 'card-1', name: 'Cartão', closing_day: 15, due_day: 25, limit: 5000 };
const JANUARY_DUE = '2026-01-25T00:00:00.000Z';

function storedTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'txn-1',
    title: 'Compra',
    amount: 100,
    type: 'expense',
    status: 'pending',
    expected_date: JANUARY_DUE,
    realized_date: '',
    purchase_date: '2026-01-10',
    is_recurring: false,
    is_silent: false,
    is_simulated: false,
    is_scheduled: false,
    account_id: '',
    card_id: 'card-1',
    category_id: '',
    project_id: '',
    invoice_id: 'inv-1',
    recurrence_id: '',
    destination_account_id: '',
    ...overrides
  };
}

function storedInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    card_id: 'card-1',
    period: '2026-01',
    due_date: JANUARY_DUE,
    status: 'OPEN',
    total_amount: 100,
    paid_amount: 0,
    ...overrides
  };
}

function buildUseCase(options: {
  transaction: Transaction;
  invoice?: Invoice;
  accounts?: Account[];
  cards?: Card[];
}) {
  const transactions = new MemoryTransactionRepository([options.transaction]);
  const invoices = new MemoryInvoiceRepository(options.invoice ? [options.invoice] : []);
  const accounts = new MemoryAccountRepository(options.accounts ?? []);
  const cards = new MemoryCardRepository(options.cards ?? [CARD]);
  const useCase = new UpdateTransactionUseCase(
    transactions,
    accounts,
    invoices,
    new SyncInvoiceUseCase(cards, invoices),
    cards,
    { now: () => '2026-01-20T12:00:00.000Z' }
  );
  return { useCase, transactions, invoices, accounts, cards };
}

describe('UpdateTransactionUseCase invoice reversion', () => {
  test('a title-only edit leaves the card invoice total unchanged', async () => {
    const stack = buildUseCase({
      transaction: storedTransaction(),
      invoice: storedInvoice(),
      accounts: [
        { id: 'acc-1', name: 'Corrente', type: 'checking', initial_balance: 1000 },
        { id: 'acc-2', name: 'Poupança', type: 'savings', initial_balance: 500 }
      ]
    });

    const updated = await stack.useCase.execute('txn-1', { title: 'Compra renomeada' });

    expect(updated.title).toBe('Compra renomeada');
    expect((await stack.invoices.findById('inv-1')).total_amount).toBe(100);
    expect(updated.invoice_id).toBe('inv-1');
    expect(updated.expected_date).toBe(JANUARY_DUE);
    expect(updated.amount).toBe(100);
    // A pending card purchase never moves cash.
    expect(stack.accounts.balance('acc-1')).toBe(1000);
    expect(stack.accounts.balance('acc-2')).toBe(500);
  });

  test('an amount edit applies the purchase once more and ends the invoice at the new amount', async () => {
    const stack = buildUseCase({
      transaction: storedTransaction(),
      invoice: storedInvoice()
    });

    const updated = await stack.useCase.execute('txn-1', { amount: 150 });

    expect(updated.amount).toBe(150);
    expect((await stack.invoices.findById('inv-1')).total_amount).toBe(150);
    expect(updated.invoice_id).toBe('inv-1');
  });

  test('an explicit-null patch clears relations while omitted fields keep their stored values', async () => {
    const stack = buildUseCase({
      transaction: storedTransaction({
        title: 'Assinatura',
        amount: 50,
        status: 'realized',
        card_id: '',
        purchase_date: '',
        invoice_id: '',
        account_id: 'acc-1',
        category_id: 'cat-1',
        project_id: 'proj-1',
        realized_date: '2026-01-05T12:00:00.000Z',
        expected_date: '2026-01-05T12:00:00.000Z'
      }),
      accounts: [{ id: 'acc-1', name: 'Corrente', type: 'checking', initial_balance: 950 }]
    });

    const patch: TransactionUpdatePatch = { category_id: null, project_id: null, amount: 60 };
    const updated = await stack.useCase.execute('txn-1', patch);

    expect(updated.category_id).toBe('');
    expect(updated.project_id).toBe('');
    expect(updated.title).toBe('Assinatura');
    expect(updated.type).toBe('expense');
    expect(updated.status).toBe('realized');
    expect(updated.account_id).toBe('acc-1');
    expect(updated.amount).toBe(60);
    // Revert the stored expense, then apply the final one.
    expect(stack.accounts.balance('acc-1')).toBe(940);
  });

  test('editing a realized transfer moves exactly the amount delta between both accounts', async () => {
    const stack = buildUseCase({
      transaction: storedTransaction({
        title: 'Transferência',
        amount: 100,
        type: 'transfer',
        status: 'realized',
        card_id: '',
        purchase_date: '',
        invoice_id: '',
        account_id: 'acc-1',
        destination_account_id: 'acc-2',
        expected_date: '2026-01-05T12:00:00.000Z',
        realized_date: '2026-01-05T12:00:00.000Z'
      }),
      accounts: [
        { id: 'acc-1', name: 'Corrente', type: 'checking', initial_balance: 900 },
        { id: 'acc-2', name: 'Poupança', type: 'savings', initial_balance: 600 }
      ]
    });

    await stack.useCase.execute('txn-1', { amount: 150 });

    expect(stack.accounts.balance('acc-1')).toBe(850);
    expect(stack.accounts.balance('acc-2')).toBe(650);
  });

  test('switching an account expense to a card origin clears the account and routes one invoice charge', async () => {
    const stack = buildUseCase({
      transaction: storedTransaction({
        title: 'Mercado',
        amount: 100,
        status: 'realized',
        card_id: '',
        purchase_date: '',
        invoice_id: '',
        account_id: 'acc-1',
        realized_date: '2026-01-05T12:00:00.000Z',
        expected_date: '2026-01-05T12:00:00.000Z'
      }),
      accounts: [{ id: 'acc-1', name: 'Corrente', type: 'checking', initial_balance: 900 }]
    });

    const updated = await stack.useCase.execute('txn-1', {
      card_id: 'card-1',
      account_id: null,
      purchase_date: '2026-01-10T00:00:00.000Z'
    });

    expect(updated.account_id).toBe('');
    expect(updated.card_id).toBe('card-1');
    expect(updated.status).toBe('pending');
    expect(updated.realized_date).toBe('');
    expect(updated.invoice_id).toBe('inv-1');
    // The stored expense left the account, so the switch returns that cash.
    expect(stack.accounts.balance('acc-1')).toBe(1000);
    expect(stack.invoices.rows).toHaveLength(1);
    expect((await stack.invoices.findById('inv-1')).total_amount).toBe(100);
  });

  test('a patch that would leave both a card origin and an account origin is rejected before any write', async () => {
    const stack = buildUseCase({
      transaction: storedTransaction({ account_id: 'acc-1', card_id: '', invoice_id: '', purchase_date: '' }),
      accounts: [{ id: 'acc-1', name: 'Corrente', type: 'checking', initial_balance: 950 }]
    });

    await expect(stack.useCase.execute('txn-1', { card_id: 'card-1' })).rejects.toBeInstanceOf(ValidationError);

    expect(stack.accounts.balance('acc-1')).toBe(950);
    expect(stack.invoices.rows).toHaveLength(0);
    expect((await stack.transactions.findById('txn-1')).title).toBe('Compra');
  });

  test('a hostile patch cannot relink the internal recurrence or invoice reference', async () => {
    const stack = buildUseCase({
      transaction: storedTransaction({ recurrence_id: 'rec-1' }),
      invoice: storedInvoice()
    });

    const hostile = { title: 'Hostile', recurrence_id: 'rec-2', invoice_id: 'inv-9' };
    const updated = await stack.useCase.execute('txn-1', hostile);

    expect(updated.title).toBe('Hostile');
    expect(updated.recurrence_id).toBe('rec-1');
    expect(updated.invoice_id).toBe('inv-1');
    expect((await stack.invoices.findById('inv-1')).total_amount).toBe(100);
  });

  test('editing a child of a part-paid or paid invoice moves only the invoice total', async () => {
    const stack = buildUseCase({
      transaction: storedTransaction({
        amount: 100,
        status: 'realized',
        realized_date: '2026-01-12T12:00:00.000Z'
      }),
      invoice: storedInvoice({ status: 'OPEN', total_amount: 100, paid_amount: 40 })
    });

    await stack.useCase.execute('txn-1', { amount: 150 });

    const partPaid = await stack.invoices.findById('inv-1');
    expect(partPaid.total_amount).toBe(150);
    expect(partPaid.paid_amount).toBe(40);
    expect(partPaid.status).toBe('OPEN');

    const paidStack = buildUseCase({
      transaction: storedTransaction({
        id: 'txn-2',
        amount: 100,
        status: 'realized',
        realized_date: '2026-01-12T12:00:00.000Z',
        invoice_id: 'inv-paid'
      }),
      invoice: storedInvoice({ id: 'inv-paid', status: 'PAID', total_amount: 100, paid_amount: 100 })
    });

    await paidStack.useCase.execute('txn-2', { amount: 50 });

    const paid = await paidStack.invoices.findById('inv-paid');
    expect(paid.total_amount).toBe(50);
    expect(paid.paid_amount).toBe(100);
    expect(paid.status).toBe('PAID');
  });
});

// Compile-time contract only: these declarations fail `tsc` if the update
// payloads widen. Clearable relations accept null; a recurrence link never
// appears in either update payload.
const acceptedSyncClear: SyncTransactionUpdatePayload = { account_id: null, purchase_date: null };
const acceptedRecurrenceClear: SyncRecurrenceUpdatePayload = { end_date: null, total_installments: null };
const rejectedPatchRelink: TransactionUpdatePatch = {
  // @ts-expect-error `recurrence_id` is create-only and never patchable.
  recurrence_id: 'rec-2'
};
const rejectedSyncRelink: SyncTransactionUpdatePayload = {
  // @ts-expect-error `recurrence_id` is create-only and never patchable.
  recurrence_id: 'rec-2'
};
void [acceptedSyncClear, acceptedRecurrenceClear, rejectedPatchRelink, rejectedSyncRelink];
