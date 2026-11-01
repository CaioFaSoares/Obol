import { describe, expect, test } from 'bun:test';
import { ProcessMonthlyRecurrencesUseCase } from '../src/application/use-cases/recurrences/ProcessMonthlyRecurrencesUseCase';
import { LaunchRecurrenceUseCase } from '../src/application/use-cases/recurrences/LaunchRecurrenceUseCase';
import { CreateRecurrenceUseCase } from '../src/application/use-cases/recurrences/CreateRecurrenceUseCase';
import { UpdateRecurrenceUseCase } from '../src/application/use-cases/recurrences/UpdateRecurrenceUseCase';
import { GenerateForecastUseCase } from '../src/application/use-cases/forecast/GenerateForecastUseCase';
import { GetCardInvoicesUseCase } from '../src/application/use-cases/cards/GetCardInvoicesUseCase';
import { DeleteInvoiceUseCase } from '../src/application/use-cases/cards/DeleteInvoiceUseCase';
import { DeleteTransactionUseCase } from '../src/application/use-cases/transactions/DeleteTransactionUseCase';
import { ReconcileInvoicesUseCase } from '../src/application/use-cases/reconciliation/ReconcileInvoicesUseCase';
import { SyncInvoiceUseCase } from '../src/application/use-cases/invoices/SyncInvoiceUseCase';
import { ValidationError } from '../src/domain/errors';
import { isoWeekOccurrence, startOfIsoWeek } from '../src/domain/utils/dateUtils';
import type { Account } from '../src/domain/entities/Account';
import type { Card } from '../src/domain/entities/Card';
import type { Category } from '../src/domain/entities/Category';
import type { Invoice } from '../src/domain/entities/Invoice';
import type { Recurrence } from '../src/domain/entities/Recurrence';
import type { Transaction } from '../src/domain/entities/Transaction';
import type { SyncClock } from '../src/domain/sync/MutationContext';

// Real use cases over mutable in-memory storage ports. Rows keep the blank
// storage representation PocketBase returns (`''` for an unset relation/date,
// `0` for an unset number), so cadence normalization is observable.

class MemoryRepository<Row extends { id: string }> {
  constructor(readonly rows: Row[], private readonly prefix: string) {}

  async findById(id: string): Promise<Row> {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown ${this.prefix} ${id}`);
    return found;
  }

  async listAll(): Promise<Row[]> {
    return this.rows;
  }

  async create(data: Partial<Row>): Promise<Row> {
    const row = { ...data, id: data.id ?? `${this.prefix}-${this.rows.length + 1}` } as Row;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Row>): Promise<Row> {
    const row = await this.findById(id);
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
    return this.rows.find(row => row.card_id === cardId && row.period === period) ?? null;
  }

  async listAll(): Promise<Invoice[]> {
    return this.rows;
  }

  async create(data: Partial<Invoice>): Promise<Invoice> {
    const row = { ...data, id: `inv-${this.rows.length + 1}` } as Invoice;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Invoice>): Promise<Invoice> {
    const row = await this.findById(id);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

function fixedClock(now: string): SyncClock {
  return { now: () => now };
}

/** `TransactionRepository` over the memory rows; list projections are unused. */
class MemoryTransactionRepository extends MemoryRepository<Transaction> {
  constructor(rows: Transaction[]) {
    super(rows, 'txn');
  }

  async list(): Promise<never> {
    throw new Error('MemoryTransactionRepository.list is not used by these tests');
  }

  async listForSummary(): Promise<never> {
    throw new Error('MemoryTransactionRepository.listForSummary is not used by these tests');
  }
}

function storedRecurrence(overrides: Partial<Recurrence> = {}): Recurrence {
  return {
    id: 'rec-1',
    name: 'Rent',
    amount: 100,
    payday: 15,
    type: 'expense',
    status: 'active',
    frequency: 'weekly',
    weekday: 2,
    account_id: 'acc-1',
    card_id: '',
    category_id: '',
    end_date: '',
    total_installments: 0,
    skipped_periods: [],
    ...overrides
  };
}

function weeklyChild(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'txn-1',
    title: 'Rent - 2026-11-03',
    amount: 100,
    type: 'expense',
    status: 'pending',
    expected_date: '2026-11-03T00:00:00.000Z',
    purchase_date: '2026-11-03T00:00:00.000Z',
    is_recurring: true,
    account_id: 'acc-1',
    card_id: '',
    invoice_id: '',
    recurrence_id: 'rec-1',
    ...overrides
  };
}

interface CronStack {
  readonly useCase: ProcessMonthlyRecurrencesUseCase;
  readonly recurrences: MemoryRepository<Recurrence>;
  readonly transactions: MemoryRepository<Transaction>;
  readonly invoices: MemoryInvoiceRepository;
  readonly cards: MemoryRepository<Card>;
}

function buildCronStack(
  recurrences: Recurrence[],
  transactions: Transaction[],
  invoices: Invoice[] = [],
  cards: Card[] = [],
  now = '2026-11-04T12:00:00.000Z'
): CronStack {
  const recurrenceRepository = new MemoryRepository<Recurrence>(recurrences, 'rec');
  const transactionRepository = new MemoryTransactionRepository(transactions);
  const cardRepository = new MemoryRepository<Card>(cards, 'card');
  const invoiceRepository = new MemoryInvoiceRepository(invoices);
  const syncInvoiceUseCase = new SyncInvoiceUseCase(cardRepository, invoiceRepository);
  return {
    useCase: new ProcessMonthlyRecurrencesUseCase(
      recurrenceRepository,
      transactionRepository,
      syncInvoiceUseCase,
      cardRepository,
      fixedClock(now)
    ),
    recurrences: recurrenceRepository,
    transactions: transactionRepository,
    invoices: invoiceRepository,
    cards: cardRepository
  };
}

function buildLaunchStack(
  recurrences: Recurrence[],
  transactions: Transaction[],
  now = '2026-11-04T12:00:00.000Z'
) {
  const recurrenceRepository = new MemoryRepository<Recurrence>(recurrences, 'rec');
  const transactionRepository = new MemoryTransactionRepository(transactions);
  const cardRepository = new MemoryRepository<Card>([], 'card');
  const invoiceRepository = new MemoryInvoiceRepository([]);
  return {
    useCase: new LaunchRecurrenceUseCase(
      recurrenceRepository,
      transactionRepository,
      new SyncInvoiceUseCase(cardRepository, invoiceRepository),
      fixedClock(now)
    ),
    recurrences: recurrenceRepository,
    transactions: transactionRepository
  };
}

describe('ISO week helpers', () => {
  test('a Sunday belongs to the ISO week that started six days earlier', () => {
    const monday = startOfIsoWeek('2026-11-08T18:00:00.000Z');
    expect(monday.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(isoWeekOccurrence('2026-11-04T12:00:00.000Z', 2)).toBe('2026-11-03T00:00:00.000Z');
    expect(isoWeekOccurrence('2026-11-04T12:00:00.000Z', 7)).toBe('2026-11-08T00:00:00.000Z');
  });

  test('a weekly occurrence may precede the clock date inside its own ISO week', () => {
    // 2027-01-01 is a Friday; the Thursday occurrence is 2026-12-31.
    expect(isoWeekOccurrence('2027-01-01T12:00:00.000Z', 4)).toBe('2026-12-31T00:00:00.000Z');
  });
});

describe('weekly recurrence cron', () => {
  test('materializes the current ISO week occurrence on the chosen weekday', async () => {
    const stack = buildCronStack([storedRecurrence()], []);

    const result = await stack.useCase.execute();

    expect(result.processed).toBe(1);
    const children = await stack.transactions.listAll();
    expect(children).toHaveLength(1);
    expect(children[0]!.expected_date).toBe('2026-11-03T00:00:00.000Z');
    expect(children[0]!.purchase_date).toBe('2026-11-03T00:00:00.000Z');
    expect(children[0]!.title).toBe('Rent - 2026-11-03');
    expect(children[0]!.recurrence_id).toBe('rec-1');
  });

  test('a second run inside the same ISO week is idempotent', async () => {
    const stack = buildCronStack([storedRecurrence()], [weeklyChild()]);

    const result = await stack.useCase.execute();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await stack.transactions.listAll()).toHaveLength(1);
  });

  test('a skipped occurrence day suppresses generation for that week', async () => {
    const stack = buildCronStack(
      [storedRecurrence({ skipped_periods: ['2026-11-03'] })],
      []
    );

    const result = await stack.useCase.execute();

    expect(result.processed).toBe(0);
    expect(await stack.transactions.listAll()).toHaveLength(0);
  });

  test('keeps materializing an occurrence dated in the previous month', async () => {
    const stack = buildCronStack(
      [storedRecurrence({ payday: 20, weekday: 4 })],
      [],
      [],
      [],
      '2027-01-01T12:00:00.000Z'
    );

    const result = await stack.useCase.execute();

    expect(result.processed).toBe(1);
    const children = await stack.transactions.listAll();
    expect(children[0]!.expected_date).toBe('2026-12-31T00:00:00.000Z');
    expect(children[0]!.title).toBe('Rent - 2026-12-31');
  });

  test('prices one weekly card child into the covering invoice', async () => {
    const stack = buildCronStack(
      [storedRecurrence({ account_id: '', card_id: 'card-1' })],
      [],
      [],
      [{ id: 'card-1', name: 'Visa', closing_day: 15, due_day: 20, limit: 5000 }]
    );

    const result = await stack.useCase.execute();

    expect(result.processed).toBe(1);
    const children = await stack.transactions.listAll();
    expect(children[0]!.purchase_date).toBe('2026-11-03T00:00:00.000Z');
    expect(children[0]!.expected_date).toBe('2026-11-20T00:00:00.000Z');
    const invoice = await stack.invoices.listAll();
    expect(invoice).toHaveLength(1);
    expect(invoice[0]!.period).toBe('2026-11');
    expect(invoice[0]!.total_amount).toBe(100);
  });
});

describe('weekly recurrence manual launch', () => {
  test('targets the next ISO week occurrence', async () => {
    const stack = buildLaunchStack([storedRecurrence()], []);

    const created = await stack.useCase.execute('rec-1');

    expect(created.purchase_date).toBe('2026-11-10T00:00:00.000Z');
    expect(created.expected_date).toBe('2026-11-10T00:00:00.000Z');
    expect(created.title).toBe('Rent - 2026-11-10');
  });

  test('accepts a replayed target day only when it is the recurrence weekday', async () => {
    const stack = buildLaunchStack([storedRecurrence()], []);

    await expect(stack.useCase.execute('rec-1', '2026-11-11')).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(await stack.transactions.listAll()).toHaveLength(0);

    const created = await stack.useCase.execute('rec-1', '2026-11-10');
    expect(created.purchase_date).toBe('2026-11-10T00:00:00.000Z');
  });

  test('numbers weekly installments and keeps the plan active at its bound', async () => {
    const stack = buildLaunchStack(
      [storedRecurrence({ total_installments: 2 })],
      [weeklyChild({ title: 'Rent - Parcela 1/2' })]
    );

    const created = await stack.useCase.execute('rec-1');

    expect(created.title).toBe('Rent - Parcela 2/2');
    expect(created.purchase_date).toBe('2026-11-10T00:00:00.000Z');
    expect((await stack.recurrences.findById('rec-1')).status).toBe('active');
  });
});

describe('weekly recurrence forecast', () => {
  test('projects one event per ISO week and skips the launched occurrence', async () => {
    const recurrenceRepository = new MemoryRepository<Recurrence>(
      [storedRecurrence({ name: 'Power', amount: 30 })],
      'rec'
    );
    const transactionRepository = new MemoryTransactionRepository([
      weeklyChild({ status: 'realized', realized_date: '2026-11-03T00:00:00.000Z' })
    ]);
    const cardRepository = new MemoryRepository<Card>([], 'card');
    const invoiceRepository = new MemoryInvoiceRepository([]);
    const useCase = new GenerateForecastUseCase(
      new MemoryRepository<Account>(
        [{ id: 'acc-1', name: 'Checking', type: 'checking', initial_balance: 1000 }],
        'acc'
      ),
      transactionRepository,
      recurrenceRepository,
      invoiceRepository,
      cardRepository,
      fixedClock('2026-11-04T12:00:00.000Z')
    );

    const forecast = await useCase.execute({ startDate: '2026-11-04', endDate: '2026-12-03' });

    const balances = new Map(forecast.timeline.map(entry => [entry.date, entry.balance]));
    expect(forecast.timeline).toHaveLength(30);
    expect(balances.get('2026-11-04')).toBe(1000);
    expect(balances.get('2026-11-09')).toBe(1000);
    expect(balances.get('2026-11-10')).toBe(970);
    expect(balances.get('2026-11-17')).toBe(940);
    expect(balances.get('2026-11-24')).toBe(910);
    expect(balances.get('2026-12-01')).toBe(880);
    expect(balances.get('2026-12-03')).toBe(880);
    expect(forecast.upcomingInvoices).toHaveLength(0);
  });
});

describe('weekly card invoice projection', () => {
  function buildProjectionStack() {
    const card: Card = {
      id: 'card-1',
      name: 'Visa',
      closing_day: 15,
      due_day: 20,
      limit: 5000
    };
    const recurrence = storedRecurrence({
      account_id: '',
      card_id: 'card-1',
      name: 'Gym',
      amount: 50,
      weekday: 2
    });
    const child = weeklyChild({
      title: 'Gym - 2026-10-20',
      amount: 50,
      expected_date: '2026-11-20T00:00:00.000Z',
      purchase_date: '2026-10-20T00:00:00.000Z',
      card_id: 'card-1',
      invoice_id: 'invoice-1'
    });
    const invoice: Invoice = {
      id: 'invoice-1',
      card_id: 'card-1',
      period: '2026-11',
      due_date: '2026-11-20T00:00:00.000Z',
      status: 'OPEN',
      total_amount: 50,
      paid_amount: 0
    };
    const cardRepository = new MemoryRepository<Card>([card], 'card');
    const invoiceRepository = new MemoryInvoiceRepository([invoice]);
    const transactionRepository = new MemoryTransactionRepository([child]);
    const recurrenceRepository = new MemoryRepository<Recurrence>([recurrence], 'rec');
    return {
      useCase: new GetCardInvoicesUseCase(
        cardRepository,
        invoiceRepository,
        transactionRepository,
        recurrenceRepository,
        fixedClock('2026-11-04T12:00:00.000Z')
      ),
      transactionRepository,
      invoiceRepository
    };
  }

  test('projects every remaining occurrence into the physical OPEN invoice', async () => {
    const stack = buildProjectionStack();

    const invoices = await stack.useCase.execute('card-1');

    const november = invoices.find(entry => entry.period === '2026-11');
    expect(november).toBeDefined();
    expect(november!.transactions).toHaveLength(4);
    expect(november!.transactions.map(line => line.expected_date)).toEqual([
      '2026-10-27T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
      '2026-11-10T00:00:00.000Z',
      '2026-11-20T00:00:00.000Z'
    ]);
    expect(november!.transactions.slice(0, 3).every(line => line.status === 'projected')).toBe(true);
    expect(november!.transactions[0]!.title).toBe('Gym - 2026-10-27');
    expect(november!.totalAmount).toBe(200);
    expect(november!.totalSpent).toBe(200);
  });

  test('projects one line per occurrence into the virtual next invoice', async () => {
    const stack = buildProjectionStack();

    const invoices = await stack.useCase.execute('card-1');

    const december = invoices.find(entry => entry.period === '2026-12');
    expect(december).toBeDefined();
    expect(december!.status).toBe('PROJECTED');
    expect(december!.transactions.map(line => line.expected_date)).toEqual([
      '2026-11-17T00:00:00.000Z',
      '2026-11-24T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z',
      '2026-12-08T00:00:00.000Z'
    ]);
    expect(december!.totalAmount).toBe(200);
  });

  test('numbers weekly installment lines by their position inside the period', async () => {
    const card: Card = {
      id: 'card-1',
      name: 'Visa',
      closing_day: 15,
      due_day: 20,
      limit: 5000
    };
    const recurrence = storedRecurrence({
      account_id: '',
      card_id: 'card-1',
      name: 'Gym',
      amount: 50,
      weekday: 2,
      total_installments: 4
    });
    const child = weeklyChild({
      title: 'Gym - Parcela 1/4',
      amount: 50,
      expected_date: '2026-11-20T00:00:00.000Z',
      purchase_date: '2026-10-20T00:00:00.000Z',
      card_id: 'card-1',
      invoice_id: 'invoice-1'
    });
    const useCase = new GetCardInvoicesUseCase(
      new MemoryRepository<Card>([card], 'card'),
      new MemoryInvoiceRepository([
        {
          id: 'invoice-1',
          card_id: 'card-1',
          period: '2026-11',
          due_date: '2026-11-20T00:00:00.000Z',
          status: 'OPEN',
          total_amount: 50,
          paid_amount: 0
        }
      ]),
      new MemoryTransactionRepository([child]),
      new MemoryRepository<Recurrence>([recurrence], 'rec'),
      fixedClock('2026-11-04T12:00:00.000Z')
    );

    const invoices = await useCase.execute('card-1');
    const november = invoices.find(entry => entry.period === '2026-11');

    expect(november!.transactions.slice(0, 3).map(line => line.title)).toEqual([
      'Gym - Parcela 2/4',
      'Gym - Parcela 3/4',
      'Gym - Parcela 4/4'
    ]);
  });
});

describe('weekly skip keys on delete', () => {
  test('deleting a weekly child stores the occurrence day', async () => {
    const child = weeklyChild({
      card_id: 'card-1',
      invoice_id: 'invoice-1',
      status: 'realized',
      realized_date: '2026-11-03T00:00:00.000Z'
    });
    const recurrence = storedRecurrence({ account_id: '', card_id: 'card-1' });
    const transactionRepository = new MemoryTransactionRepository([child]);
    const accountRepository = new MemoryRepository<Account>(
      [{ id: 'acc-1', name: 'Checking', type: 'checking', initial_balance: 1000 }],
      'acc'
    );
    const invoiceRepository = new MemoryInvoiceRepository([
      {
        id: 'invoice-1',
        card_id: 'card-1',
        period: '2026-11',
        due_date: '2026-11-20T00:00:00.000Z',
        status: 'OPEN',
        total_amount: 100,
        paid_amount: 0
      }
    ]);
    const recurrenceRepository = new MemoryRepository<Recurrence>([recurrence], 'rec');
    const useCase = new DeleteTransactionUseCase(
      transactionRepository,
      accountRepository,
      invoiceRepository,
      recurrenceRepository
    );

    await useCase.execute('txn-1');

    const updated = await recurrenceRepository.findById('rec-1');
    expect(updated.skipped_periods).toEqual(['2026-11-03']);
  });

  test('deleting a monthly child still stores the month and invoice period', async () => {
    const child = weeklyChild({
      status: 'realized',
      realized_date: '2026-11-03T00:00:00.000Z',
      invoice_id: '',
      card_id: ''
    });
    const recurrence = storedRecurrence({
      frequency: 'monthly',
      weekday: 0,
      payday: 3
    });
    const transactionRepository = new MemoryTransactionRepository([child]);
    const recurrenceRepository = new MemoryRepository<Recurrence>([recurrence], 'rec');
    const useCase = new DeleteTransactionUseCase(
      transactionRepository,
      new MemoryRepository<Account>(
        [{ id: 'acc-1', name: 'Checking', type: 'checking', initial_balance: 1000 }],
        'acc'
      ),
      new MemoryInvoiceRepository([]),
      recurrenceRepository
    );

    await useCase.execute('txn-1');

    const updated = await recurrenceRepository.findById('rec-1');
    expect(updated.skipped_periods).toEqual(['2026-11']);
  });
});

describe('weekly skip keys on invoice delete', () => {
  function buildDeleteStack(children: Transaction[], recurrence: Recurrence) {
    const transactionRepository = new MemoryTransactionRepository(children);
    const invoiceRepository = new MemoryInvoiceRepository([
      {
        id: 'invoice-1',
        card_id: 'card-1',
        period: '2026-11',
        due_date: '2026-11-20T00:00:00.000Z',
        status: 'OPEN',
        total_amount: 200,
        paid_amount: 0
      }
    ]);
    const recurrenceRepository = new MemoryRepository<Recurrence>([recurrence], 'rec');
    const useCase = new DeleteInvoiceUseCase(
      invoiceRepository,
      transactionRepository,
      recurrenceRepository,
      new MemoryRepository<Account>([], 'acc')
    );
    return { useCase, recurrenceRepository, transactionRepository };
  }

  test('records one day key per deleted weekly child', async () => {
    const recurrence = storedRecurrence({
      account_id: '',
      card_id: 'card-1',
      skipped_periods: ['2026-10-27']
    });
    const stack = buildDeleteStack(
      [
        weeklyChild({
          id: 'txn-1',
          card_id: 'card-1',
          invoice_id: 'invoice-1',
          purchase_date: '2026-11-03T00:00:00.000Z',
          expected_date: '2026-11-20T00:00:00.000Z'
        }),
        weeklyChild({
          id: 'txn-2',
          card_id: 'card-1',
          invoice_id: 'invoice-1',
          purchase_date: '2026-11-10T00:00:00.000Z',
          expected_date: '2026-11-20T00:00:00.000Z'
        })
      ],
      recurrence
    );

    await stack.useCase.execute('card-1', '2026-11');

    const updated = await stack.recurrenceRepository.findById('rec-1');
    expect(updated.skipped_periods).toEqual(['2026-10-27', '2026-11-03', '2026-11-10']);
    expect(await stack.transactionRepository.listAll()).toHaveLength(0);
  });

  test('records the invoice period for a monthly recurrence', async () => {
    const recurrence = storedRecurrence({ frequency: 'monthly', weekday: 0, payday: 3 });
    const stack = buildDeleteStack(
      [
        weeklyChild({
          id: 'txn-1',
          card_id: 'card-1',
          invoice_id: 'invoice-1',
          purchase_date: '2026-11-03T00:00:00.000Z',
          expected_date: '2026-11-20T00:00:00.000Z'
        })
      ],
      recurrence
    );

    await stack.useCase.execute('card-1', '2026-11');

    const updated = await stack.recurrenceRepository.findById('rec-1');
    expect(updated.skipped_periods).toEqual(['2026-11']);
  });
});

describe('skipped period prune', () => {
  test('compares the month prefix of both key shapes', async () => {
    const recurrence = storedRecurrence({
      skipped_periods: ['2026-06-30', '2026-07-07', '2026-11-03', '2026-09']
    });
    const recurrenceRepository = new MemoryRepository<Recurrence>([recurrence], 'rec');
    const useCase = new ReconcileInvoicesUseCase(
      new MemoryTransactionRepository([]),
      new MemoryInvoiceRepository([]),
      recurrenceRepository,
      new SyncInvoiceUseCase(new MemoryRepository<Card>([], 'card'), new MemoryInvoiceRepository([])),
      fixedClock('2026-11-04T12:00:00.000Z')
    );

    await useCase.execute();

    const updated = await recurrenceRepository.findById('rec-1');
    // Cutoff is 2026-08: June and July keys (day and month shape) are pruned.
    expect(updated.skipped_periods).toEqual(['2026-11-03', '2026-09']);
  });
});

describe('recurrence cadence validation', () => {
  test('a weekly create requires an ISO weekday and a monthly create stores the blank', async () => {
    const recurrenceRepository = new MemoryRepository<Recurrence>([], 'rec');
    const useCase = new CreateRecurrenceUseCase(
      recurrenceRepository,
      new MemoryRepository<Account>([], 'acc'),
      new MemoryRepository<Card>([], 'card')
    );

    await expect(
      useCase.execute({
        name: 'Gym',
        amount: 50,
        payday: 15,
        type: 'expense',
        frequency: 'weekly'
      })
    ).rejects.toBeInstanceOf(ValidationError);

    const created = await useCase.execute({
      name: 'Rent',
      amount: 100,
      payday: 15,
      type: 'expense'
    });
    expect(created.frequency).toBe('monthly');
    expect(created.weekday).toBe(0);
  });

  test('a weekly patch requires a weekday and switching to monthly clears it', async () => {
    const recurrenceRepository = new MemoryRepository<Recurrence>(
      [storedRecurrence({ frequency: 'monthly', weekday: 0 })],
      'rec'
    );
    const useCase = new UpdateRecurrenceUseCase(
      recurrenceRepository,
      new MemoryRepository<Account>(
        [{ id: 'acc-1', name: 'Checking', type: 'checking', initial_balance: 1000 }],
        'acc'
      ),
      new MemoryRepository<Card>([], 'card'),
      new MemoryRepository<Category>([], 'cat')
    );

    await expect(
      useCase.execute('rec-1', { frequency: 'weekly' })
    ).rejects.toBeInstanceOf(ValidationError);

    const weekly = await useCase.execute('rec-1', { frequency: 'weekly', weekday: 5 });
    expect(weekly.frequency).toBe('weekly');
    expect(weekly.weekday).toBe(5);

    const monthly = await useCase.execute('rec-1', { frequency: 'monthly' });
    expect(monthly.frequency).toBe('monthly');
    expect(monthly.weekday).toBe(0);
  });
});
